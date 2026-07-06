import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'

const router = Router()

// Get all programs
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('programs')
      .select('*, institution:institutions(name, city), category:program_categories(name, color)')
      .eq('is_active', true)
      .order('name')

    if (error) throw error
    res.json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Get programs by institution
router.get('/institution/:institutionId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('programs')
      .select('*, category:program_categories(name, color)')
      .eq('institution_id', req.params.institutionId)
      .eq('is_active', true)

    if (error) throw error
    res.json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

// Create program (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('programs')
      .insert(req.body)
      .select()

    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
