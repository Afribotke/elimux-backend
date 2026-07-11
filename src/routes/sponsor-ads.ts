import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'

const router = Router()

// GET /api/sponsor-ads?placement=homepage — active ads for a placement (public)
router.get('/', async (req, res) => {
  try {
    const { placement } = req.query

    if (!placement) {
      return res.status(400).json({ error: 'placement query param is required' })
    }

    const { data, error } = await supabase
      .from('sponsor_ads')
      .select('*, sponsor:sponsors(name, logo_url)')
      .eq('placement', placement as string)
      .eq('is_active', true)
      .gt('end_date', new Date().toISOString())
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List sponsor ads error:', error)
    res.status(500).json({ error: 'Failed to fetch sponsor ads' })
  }
})

// GET /api/sponsor-ads/admin — all ads regardless of placement/active/expiry (admin only)
router.get('/admin', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sponsor_ads')
      .select('*, sponsor:sponsors(name, logo_url)')
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List admin sponsor ads error:', error)
    res.status(500).json({ error: 'Failed to fetch sponsor ads' })
  }
})

// POST /api/sponsor-ads (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { sponsor_id, title, description, image_url, target_url, placement, start_date, end_date } = req.body

    if (!title || !placement || !target_url || !start_date || !end_date) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['title', 'placement', 'target_url', 'start_date', 'end_date'],
      })
    }

    const { data, error } = await supabase
      .from('sponsor_ads')
      .insert({
        sponsor_id: sponsor_id || null,
        title,
        description: description || null,
        image_url: image_url || null,
        target_url,
        placement,
        start_date,
        end_date,
        is_active: true,
      })
      .select('*, sponsor:sponsors(name, logo_url)')
      .single()

    if (error) throw error

    res.status(201).json({ data, message: 'Sponsor ad created successfully' })
  } catch (error: any) {
    console.error('Create sponsor ad error:', error)
    res.status(500).json({ error: 'Failed to create sponsor ad', details: error.message })
  }
})

// PATCH /api/sponsor-ads/:id (admin only) — toggle is_active or update ad fields
router.patch('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { sponsor_id, title, description, image_url, target_url, placement, start_date, end_date, is_active } = req.body

    const updates: Record<string, unknown> = {}
    if (sponsor_id !== undefined) updates.sponsor_id = sponsor_id
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description
    if (image_url !== undefined) updates.image_url = image_url
    if (target_url !== undefined) updates.target_url = target_url
    if (placement !== undefined) updates.placement = placement
    if (start_date !== undefined) updates.start_date = start_date
    if (end_date !== undefined) updates.end_date = end_date
    if (is_active !== undefined) updates.is_active = is_active

    const { data, error } = await supabase
      .from('sponsor_ads')
      .update(updates)
      .eq('id', id)
      .select('*, sponsor:sponsors(name, logo_url)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Sponsor ad not found' })

    res.json({ data, message: 'Sponsor ad updated successfully' })
  } catch (error: any) {
    console.error('Update sponsor ad error:', error)
    res.status(500).json({ error: 'Failed to update sponsor ad', details: error.message })
  }
})

// POST /api/sponsor-ads/:id/click — track a click (public)
router.post('/:id/click', async (req, res) => {
  try {
    const { id } = req.params
    const deviceId = getDeviceFingerprint(req)
    const forwardedFor = req.headers['x-forwarded-for']
    const ip = typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : req.socket.remoteAddress || null

    const { error: clickError } = await supabase
      .from('ad_clicks')
      .insert({ ad_id: id, user_device_id: deviceId, ip_address: ip })

    if (clickError) throw clickError

    const { data: ad, error: fetchError } = await supabase
      .from('sponsor_ads')
      .select('click_count')
      .eq('id', id)
      .single()

    if (fetchError || !ad) return res.status(404).json({ error: 'Sponsor ad not found' })

    const { error: updateError } = await supabase
      .from('sponsor_ads')
      .update({ click_count: (ad.click_count || 0) + 1 })
      .eq('id', id)

    if (updateError) throw updateError

    res.json({ success: true })
  } catch (error: any) {
    console.error('Track ad click error:', error)
    res.status(500).json({ error: 'Failed to track click' })
  }
})

export default router
