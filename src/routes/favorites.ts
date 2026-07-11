import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'

const router = Router()

router.post('/', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)
    const { item_id, item_type } = req.body

    if (!item_id || !item_type) {
      return res.status(400).json({ success: false, error: 'item_id and item_type required' })
    }

    // No unique constraint on (device_id, item_id, item_type) in the DB, so a
    // plain insert would duplicate on retry - matters now that this can be
    // replayed by useBackgroundSync after a queued offline favorite. Check
    // first rather than insert-and-catch, since there's nothing to catch
    // without a constraint backing it.
    const { data: existing } = await supabase
      .from('user_favorites')
      .select('*')
      .eq('device_id', deviceId)
      .eq('item_id', item_id)
      .eq('item_type', item_type)
      .maybeSingle()

    if (existing) {
      return res.status(200).json({ success: true, data: [existing] })
    }

    const { data, error } = await supabase
      .from('user_favorites')
      .insert({ device_id: deviceId, item_id, item_type })
      .select()

    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)

    const { data, error } = await supabase
      .from('user_favorites')
      .select('*')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ success: true, data: data || [] })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)
    const { id } = req.params

    const { error } = await supabase
      .from('user_favorites')
      .delete()
      .eq('id', id)
      .eq('device_id', deviceId)

    if (error) throw error
    res.json({ success: true, message: 'Favorite removed' })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// DELETE /api/favorites - remove by (item_id, item_type) instead of row id.
// FavoriteButton only ever knows "this item", not the user_favorites row id
// its earlier POST created (it doesn't fetch the list), and a queued offline
// "remove" action replayed later has the same problem - this is the address
// both actually have on hand.
router.delete('/', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)
    const { item_id, item_type } = req.body

    if (!item_id || !item_type) {
      return res.status(400).json({ success: false, error: 'item_id and item_type required' })
    }

    const { error } = await supabase
      .from('user_favorites')
      .delete()
      .eq('device_id', deviceId)
      .eq('item_id', item_id)
      .eq('item_type', item_type)

    if (error) throw error
    res.json({ success: true, message: 'Favorite removed' })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
