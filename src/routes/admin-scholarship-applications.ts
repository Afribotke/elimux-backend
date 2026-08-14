import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { adminMiddleware } from '../middleware/auth'

const router = Router()
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/admin/scholarship-applications
// Query: ?status=&page=1&limit=20
router.get('/', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined
    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 20

    let query = supabase
      .from('scholarship_applications')
      .select('*, scholarship:scholarships(*)', { count: 'exact' })
      .in('status', ['submitted', 'under_review', 'awarded', 'rejected'])

    if (status) query = query.eq('status', status)

    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error
    res.json({ data: data || [], total: count || 0 })
  } catch (error: any) {
    console.error('Admin list applications error:', error)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/admin/scholarship-applications/:id/review
// Body: { status: 'under_review' | 'awarded' | 'rejected', review_score?, review_notes? }
router.post('/:id/review', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { status, review_score, review_notes } = req.body

    if (!status || !['under_review', 'awarded', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be under_review, awarded, or rejected' })
    }

    const updateData: any = {
      status,
      review_score: review_score ?? null,
      review_notes: review_notes ?? null,
      reviewed_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('scholarship_applications')
      .update(updateData)
      .eq('id', id)
      .select('*, scholarship:scholarships(*)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Application not found' })

    res.json({ data })
  } catch (error: any) {
    console.error('Admin review error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
