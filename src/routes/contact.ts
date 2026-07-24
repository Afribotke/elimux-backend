import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// ============================================================
// SUBMISSION GUARDS — rate limit (mirrors reviews.ts)
// ============================================================
const submissionLog = new Map<string, number[]>() // ip -> timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 5 // max 5 submissions per IP per hour

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

// POST /api/contact
router.post('/', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body

    const ip = clientIp(req)
    const now = Date.now()
    const cutoff = now - RATE_LIMIT_WINDOW_MS
    const recent = (submissionLog.get(ip) || []).filter((t) => t > cutoff)

    if (recent.length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many messages submitted. Please try again later.' })
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Name is required' })
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'A valid email is required' })
    }
    if (!message || String(message).trim().length < 10) {
      return res.status(400).json({ error: 'Message must be at least 10 characters' })
    }
    if (String(message).length > 5000) {
      return res.status(400).json({ error: 'Message must be 5000 characters or fewer' })
    }

    const { data, error } = await supabase
      .from('contact_messages')
      .insert({
        name: String(name).trim().slice(0, 100),
        email: String(email).trim(),
        subject: subject ? String(subject).trim().slice(0, 200) : null,
        message: String(message).trim(),
        submitted_ip: ip,
      })
      .select()
      .single()

    if (error) return res.status(500).json({ error: error.message })

    recent.push(now)
    submissionLog.set(ip, recent)

    res.status(201).json({ data, message: 'Message sent' })
  } catch (error: any) {
    console.error('Submit contact message error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
