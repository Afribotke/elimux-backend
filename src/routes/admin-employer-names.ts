import { Router } from 'express'
import { adminAuth } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/admin/employer-names?page=1&limit=25&q=search
router.get('/', adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1'))
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '25')))
    const from = (page - 1) * limit
    const to = from + limit - 1
    const q = ((req.query.q as string) || '').trim()

    let query = supabase
      .from('employer_names')
      .select(
        'id, name, normalized_name, suggested_website_url, verified_website_url, verification_status, discovery_status, is_active, created_at',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })

    if (q) query = query.ilike('name', `%${q}%`)

    const { data, error, count } = await query.range(from, to)
    if (error) throw error

    res.json({ data: data || [], count: count || 0, page, limit })
  } catch (error: any) {
    console.error('admin employer-names list error:', error)
    res.status(500).json({ error: error.message || 'Failed to load employer names' })
  }
})

export default router
