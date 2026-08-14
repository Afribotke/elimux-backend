import { Router, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { matchScholarships, StudentProfile } from '../services/scholarshipMatcher'
import { requireUser, UserAuthRequest } from '../middleware/user-auth'

const router = Router()
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/scholarships/match — public, no auth required (guest matching)
router.post('/match', async (req, res: Response) => {
  try {
    const { profile, limit = 20 } = req.body

    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'Profile object required' })
    }

    const results = await matchScholarships(profile as StudentProfile, limit)
    res.json({ data: results, meta: { total: results.length } })
  } catch (error: any) {
    console.error('Match error:', error)
    res.status(500).json({ error: error.message || 'Matching failed' })
  }
})

// GET /api/scholarships/match/me — authenticated, uses saved scholarship profile
router.get('/match/me', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const { data: profile, error } = await supabase
      .from('scholarship_profiles')
      .select('*')
      .eq('user_id', req.userId)
      .single()

    if (error || !profile) {
      return res.status(404).json({ error: 'Scholarship profile not found. Complete your profile first.' })
    }

    const results = await matchScholarships(profile, 20)

    await supabase.from('scholarship_profiles').update({ last_matched_at: new Date().toISOString() }).eq('user_id', req.userId)

    res.json({ data: results, meta: { total: results.length } })
  } catch (error: any) {
    console.error('Match me error:', error)
    res.status(500).json({ error: error.message || 'Matching failed' })
  }
})

export default router
