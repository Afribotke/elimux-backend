import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'

const router = Router()

// Get all institutions
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('institutions')
      .select('*, type:institution_types(name), country:countries(name, flag_emoji)')
      .eq('is_active', true)
      .order('name')

    if (error) throw error
    res.json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get institution by ID
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('institutions')
      .select('*, type:institution_types(name), country:countries(name, flag_emoji), programs(*)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Create institution (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('institutions')
      .insert(req.body)
      .select()

    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
