import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// GET /api/reviews?program_id=... or ?institution_id=...
router.get('/', async (req, res) => {
  const { program_id, institution_id } = req.query
  const page = parsePositiveInt(req.query.page, 1)
  const limit = parsePositiveInt(req.query.limit, 10)

  let query = supabase
    .from('reviews')
    .select('*', { count: 'exact' })
    .eq('is_active', true)
    .order('created_at', { ascending: false })

  if (program_id) query = query.eq('program_id', program_id as string)
  if (institution_id) query = query.eq('institution_id', institution_id as string)

  const from = (page - 1) * limit
  const to = from + limit - 1

  const { data, count, error } = await query.range(from, to)

  if (error) return res.status(500).json({ error: error.message })

  res.json({
    reviews: data || [],
    meta: { total: count || 0, page, limit },
  })
})

// POST /api/reviews
router.post('/', async (req, res) => {
  const { program_id, institution_id, reviewer_name, reviewer_email, rating, title, content, pros, cons, would_recommend } = req.body

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be 1-5' })
  }

  if (!program_id && !institution_id) {
    return res.status(400).json({ error: 'program_id or institution_id required' })
  }

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      program_id,
      institution_id,
      reviewer_name,
      reviewer_email,
      rating,
      title,
      content,
      pros: pros || [],
      cons: cons || [],
      would_recommend,
      is_active: true,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  res.status(201).json(data)
})

// POST /api/reviews/:id/helpful
router.post('/:id/helpful', async (req, res) => {
  const { id } = req.params

  const { error: rpcError } = await supabase.rpc('increment_helpful_count', { review_id: id })

  if (rpcError) {
    // Fallback if the increment_helpful_count() function doesn't exist yet -
    // not atomic like the RPC, but keeps the endpoint working either way.
    const { data: review, error: fetchError } = await supabase
      .from('reviews')
      .select('helpful_count')
      .eq('id', id)
      .single()

    if (fetchError) return res.status(404).json({ error: 'Review not found' })

    const { error: updateError } = await supabase
      .from('reviews')
      .update({ helpful_count: (review.helpful_count || 0) + 1 })
      .eq('id', id)

    if (updateError) return res.status(500).json({ error: updateError.message })
  }

  res.json({ success: true })
})

export default router
