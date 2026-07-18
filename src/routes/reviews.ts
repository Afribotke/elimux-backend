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
    .eq('status', 'approved')
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

// ============================================================
// SUBMISSION GUARDS — rate limit, duplicate guard, link filter
// ============================================================
const submissionLog = new Map<string, number[]>() // ip -> timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 5 // max 5 submissions per IP per hour
const DUPLICATE_WINDOW_DAYS = 30
const LINK_PATTERN = /(https?:\/\/|www\.)/i

setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS
  for (const [ip, hits] of submissionLog) {
    const fresh = hits.filter((t) => t > cutoff)
    if (fresh.length === 0) submissionLog.delete(ip)
    else submissionLog.set(ip, fresh)
  }
}, 10 * 60 * 1000).unref()

function clientIp(req: any): string {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

// POST /api/reviews
router.post('/', async (req, res) => {
  try {
    const { program_id, institution_id, reviewer_name, reviewer_email, rating, title, content, pros, cons, would_recommend, is_anonymous } = req.body

    // --- Rate limit: max 5 submissions per IP per hour ---
    const ip = clientIp(req)
    const now = Date.now()
    const cutoff = now - RATE_LIMIT_WINDOW_MS
    const recent = (submissionLog.get(ip) || []).filter((t) => t > cutoff)

    if (recent.length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many reviews submitted. Please try again later.' })
    }

    // --- Validation ---
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5' })
    }

    if (!content || String(content).trim().length < 10) {
      return res.status(400).json({ error: 'Review content must be at least 10 characters' })
    }

    if (String(content).length > 2000) {
      return res.status(400).json({ error: 'Review content must be 2000 characters or fewer' })
    }

    if (title && String(title).length > 120) {
      return res.status(400).json({ error: 'Title must be 120 characters or fewer' })
    }

    if (!program_id && !institution_id) {
      return res.status(400).json({ error: 'program_id or institution_id required' })
    }

    // --- Link filter: the #1 spam vector ---
    if (LINK_PATTERN.test(String(content)) || (title && LINK_PATTERN.test(String(title)))) {
      return res.status(400).json({ error: 'Reviews cannot contain links' })
    }

    // --- Duplicate guard: same email can't review the same target twice within 30 days ---
    if (reviewer_email) {
      const duplicateCutoff = new Date(now - DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

      let dupQuery = supabase
        .from('reviews')
        .select('id')
        .eq('reviewer_email', reviewer_email)
        .gte('created_at', duplicateCutoff)
        .limit(1)

      if (program_id) dupQuery = dupQuery.eq('program_id', program_id)
      else dupQuery = dupQuery.eq('institution_id', institution_id)

      const { data: existing } = await dupQuery

      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'You have already reviewed this recently. You can submit another review after 30 days.' })
      }
    }

    // --- Insert ---
    const { data, error } = await supabase
      .from('reviews')
      .insert({
        program_id,
        institution_id,
        user_id: null, // no login flow exists yet - all reviews are anonymous
        reviewer_name: reviewer_name ? String(reviewer_name).slice(0, 100) : null,
        reviewer_email: reviewer_email || null,
        rating,
        title: title || null,
        content: String(content).trim(),
        pros: pros || null, // column is `text`, not `text[]` - stored as a plain (comma-separated) string
        cons: cons || null,
        would_recommend: would_recommend ?? null,
        is_anonymous: !!is_anonymous,
        is_active: true,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    // Record the submission against the rate limit (only successful ones)
    recent.push(now)
    submissionLog.set(ip, recent)

    res.status(201).json(data)
  } catch (error: any) {
    console.error('Submit review error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
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
