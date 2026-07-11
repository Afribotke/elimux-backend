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

export default router
