import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminAuth } from '../middleware/auth'
import webpush from '../lib/webpush'

const router = Router()

// Matches queued_actions' DB check constraint (queued_actions_action_type_check),
// which PostgREST doesn't reflect in its schema - found empirically by probing.
// Keep in sync if the constraint changes (elimux-sql migration would be the
// place to look for the authoritative definition, if one ever gets added there).
const QUEUEABLE_ACTION_TYPES = ['favorite', 'review', 'application', 'share']

// POST /api/pwa/subscribe - upsert a push subscription (public: called by any
// visitor's browser once they grant notification permission)
router.post('/subscribe', async (req, res) => {
  try {
    const { device_id, subscription, preferences } = req.body || {}

    if (!device_id || !subscription) {
      return res.status(400).json({ error: 'device_id and subscription are required' })
    }

    const payload: Record<string, unknown> = { device_id, subscription, is_active: true }
    // Column is user_preferences, not preferences - keep the request body matching
    // the spec while writing to the real column name.
    if (preferences !== undefined) payload.user_preferences = preferences

    const { data, error } = await supabase
      .from('push_subscriptions')
      .upsert(payload, { onConflict: 'device_id' })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ data })
  } catch (error: any) {
    console.error('PWA subscribe error:', error)
    res.status(500).json({ error: 'Failed to save subscription', details: error.message })
  }
})

// DELETE /api/pwa/subscribe - soft-unsubscribe (public, keyed by device_id only -
// matches every other device-scoped endpoint in this app, no separate auth)
router.delete('/subscribe', async (req, res) => {
  try {
    const { device_id } = req.body || {}
    if (!device_id) return res.status(400).json({ error: 'device_id is required' })

    const { data, error } = await supabase
      .from('push_subscriptions')
      .update({ is_active: false })
      .eq('device_id', device_id)
      .select()
      .maybeSingle()

    if (error) throw error

    res.json({ data, message: 'Unsubscribed' })
  } catch (error: any) {
    console.error('PWA unsubscribe error:', error)
    res.status(500).json({ error: 'Failed to unsubscribe' })
  }
})

// POST /api/pwa/notify (admin only) - send a push to all active subscriptions,
// or a specific set via target_devices
router.post('/notify', adminAuth, async (req, res) => {
  try {
    const { title, body, url, target_devices } = req.body || {}

    if (!title || !body) {
      return res.status(400).json({ error: 'title and body are required' })
    }

    let query = supabase.from('push_subscriptions').select('id, device_id, subscription').eq('is_active', true)
    if (Array.isArray(target_devices) && target_devices.length > 0) {
      query = query.in('device_id', target_devices)
    }

    const { data: subscriptions, error } = await query
    if (error) throw error

    const payload = JSON.stringify({ title, body, url: url || '/' })
    let sent = 0
    let failed = 0
    const deactivated: string[] = []

    await Promise.all(
      (subscriptions || []).map(async (row: any) => {
        try {
          await webpush.sendNotification(row.subscription, payload)
          sent++
        } catch (err: any) {
          failed++
          // 404/410 = the browser revoked or expired this subscription - clean it up
          // rather than retrying it on every future notify call.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await supabase.from('push_subscriptions').update({ is_active: false }).eq('id', row.id)
            deactivated.push(row.device_id)
          } else {
            console.error(`Push send failed for device ${row.device_id}:`, err?.message || err)
          }
        }
      })
    )

    res.json({ data: { sent, failed, deactivated, total: subscriptions?.length || 0 } })
  } catch (error: any) {
    console.error('PWA notify error:', error)
    res.status(500).json({ error: 'Failed to send notifications', details: error.message })
  }
})

// POST /api/pwa/queue - queue an action a device couldn't complete while offline
router.post('/queue', async (req, res) => {
  try {
    const { device_id, action_type, payload } = req.body || {}

    if (!device_id || !action_type) {
      return res.status(400).json({ error: 'device_id and action_type are required' })
    }
    if (!QUEUEABLE_ACTION_TYPES.includes(action_type)) {
      return res.status(400).json({ error: 'Invalid action_type', allowed: QUEUEABLE_ACTION_TYPES })
    }

    const { data, error } = await supabase
      .from('queued_actions')
      .insert({ device_id, action_type, payload: payload ?? null, status: 'pending', retry_count: 0 })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ data })
  } catch (error: any) {
    console.error('PWA queue error:', error)
    res.status(500).json({ error: 'Failed to queue action', details: error.message })
  }
})

// GET /api/pwa/queue?device_id=xxx - a device's pending actions, so it can
// replay them itself once back online
router.get('/queue', async (req, res) => {
  try {
    const { device_id } = req.query
    if (!device_id) return res.status(400).json({ error: 'device_id query param is required' })

    const { data, error } = await supabase
      .from('queued_actions')
      .select('*')
      .eq('device_id', device_id as string)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })

    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('PWA queue read error:', error)
    res.status(500).json({ error: 'Failed to fetch queued actions' })
  }
})

// POST /api/pwa/sync - mark a device's pending actions as synced. The actual
// replay (re-issuing each queued request) happens client-side in
// useBackgroundSync once connectivity returns - the client already has
// everything needed to redo the original call, and knows definitively whether
// it succeeded. This endpoint is the bookkeeping step after that: the client
// calls it once its own replay of each action has succeeded.
router.post('/sync', async (req, res) => {
  try {
    const { device_id } = req.body || {}
    if (!device_id) return res.status(400).json({ error: 'device_id is required' })

    const { data, error } = await supabase
      .from('queued_actions')
      .update({ status: 'synced', synced_at: new Date().toISOString() })
      .eq('device_id', device_id)
      .eq('status', 'pending')
      .select()

    if (error) throw error

    res.json({ data: data || [], message: `${data?.length || 0} action(s) synced` })
  } catch (error: any) {
    console.error('PWA sync error:', error)
    res.status(500).json({ error: 'Failed to sync actions' })
  }
})

export default router
