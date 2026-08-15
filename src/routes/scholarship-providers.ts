import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'

const router = Router()

// POST /api/scholarship-providers/:id/claim
// Any authenticated user can claim a provider profile.
// is_partner remains false until admin approval.
router.post('/:id/claim', async (req, res) => {
  try {
    const { id } = req.params
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await supabase.auth.getUser(token)
    if (userError || !userData.user) {
      return res.status(401).json({ error: 'Invalid token' })
    }

    const { data: existing, error: existingError } = await supabase
      .from('scholarship_providers')
      .select('claimed_by, is_partner')
      .eq('id', id)
      .single()

    if (existingError) {
      if (existingError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Provider not found' })
      }
      throw existingError
    }

    if (existing?.claimed_by) {
      return res.status(409).json({ error: 'This provider has already been claimed' })
    }

    const { data, error } = await supabase
      .from('scholarship_providers')
      .update({
        claimed_by: userData.user.id,
        claimed_at: new Date().toISOString(),
        is_partner: false,
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    res.json({ data })
  } catch (error: any) {
    console.error('Claim provider error:', error)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/scholarship-providers/:id/approve-partnership
// Admin only. Flips is_partner to true after contract signature.
router.post('/:id/approve-partnership', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { data, error } = await supabase
      .from('scholarship_providers')
      .update({ is_partner: true })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Provider not found' })
    res.json({ data })
  } catch (error: any) {
    console.error('Approve partnership error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/scholarship-providers?claimed_only=true&partner_only=true
// Admin only.
router.get('/', adminMiddleware, async (req, res) => {
  try {
    let query = supabase.from('scholarship_providers').select('*')
    if (req.query.claimed_only === 'true') {
      query = query.not('claimed_by', 'is', null)
    }
    if (req.query.partner_only === 'true') {
      query = query.eq('is_partner', true)
    }
    const { data, error } = await query.order('name')
    if (error) throw error
    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List providers error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
