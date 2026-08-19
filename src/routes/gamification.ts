import { Router, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireUser, UserAuthRequest } from '../middleware/user-auth'

const router = Router()

async function totalPointsForUser(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('gamification_leaderboard')
    .select('total_points')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data?.total_points ?? 0
}

// Awards any active points_total badges the user now qualifies for and
// hasn't already earned. Badges with any other criteria_type are left for
// manual/future evaluation - the schema only carries a threshold, not which
// action it applies to, so points_total is the one kind this can judge.
//
// Bonus points for a newly-earned badge are inserted directly rather than
// through award_points() - there is no 'badge' row in gamification_actions
// (the RPC would reject the action_key), and this path takes no client
// input, so the RPC's action_key validation isn't protecting anything here.
async function awardEligibleBadges(userId: string, studentId: string | null, totalPoints: number) {
  const { data: badges, error: badgesError } = await supabase
    .from('gamification_badges')
    .select('*')
    .eq('is_active', true)
    .eq('criteria_type', 'points_total')
    .lte('criteria_threshold', totalPoints)

  if (badgesError) throw badgesError
  if (!badges || badges.length === 0) return []

  const { data: alreadyEarned, error: earnedError } = await supabase
    .from('user_badges')
    .select('badge_id')
    .eq('user_id', userId)
    .in('badge_id', badges.map((b) => b.id))

  if (earnedError) throw earnedError

  const earnedIds = new Set((alreadyEarned || []).map((b) => b.badge_id))
  const newlyEligible = badges.filter((b) => !earnedIds.has(b.id))
  if (newlyEligible.length === 0) return []

  const { error: insertBadgesError } = await supabase
    .from('user_badges')
    .insert(newlyEligible.map((b) => ({ badge_id: b.id, user_id: userId })))

  if (insertBadgesError) throw insertBadgesError

  const bonusRows = newlyEligible
    .filter((b) => b.points_reward && b.points_reward > 0)
    .map((b) => ({
      user_id: userId,
      student_id: studentId,
      action_key: null,
      points: b.points_reward,
      reference_type: 'badge',
      reference_id: b.id,
    }))

  if (bonusRows.length > 0) {
    const { error: bonusError } = await supabase.from('gamification_points').insert(bonusRows)
    if (bonusError) throw bonusError
  }

  return newlyEligible
}

// POST /api/gamification/points - award points for an action.
// Points are never client-supplied - action_key is looked up server-side
// (in the award_points RPC) against gamification_actions.points, so an
// authenticated user can't self-award an arbitrary amount. Valid keys today:
// daily_login, refer_friend, review_employer, apply_internship,
// complete_internship, logbook_entry, profile_complete, upload_resume.
router.post('/points', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { action_key, student_id, reference_type, reference_id } = req.body

    if (!action_key || typeof action_key !== 'string') {
      return res.status(400).json({ error: 'action_key is required' })
    }

    const { data, error } = await supabase.rpc('award_points', {
      p_user_id: userId,
      p_action_key: action_key,
      p_points: null,
      p_student_id: student_id || null,
      p_reference_type: reference_type || null,
      p_reference_id: reference_id || null,
    })

    if (error) throw error
    if (!data?.success) {
      return res.status(400).json(data)
    }

    const totalPoints = await totalPointsForUser(userId)
    const badgesEarned = await awardEligibleBadges(userId, student_id || null, totalPoints)

    res.status(201).json({
      data,
      total_points: badgesEarned.length > 0 ? await totalPointsForUser(userId) : totalPoints,
      badges_earned: badgesEarned,
    })
  } catch (error: any) {
    console.error('Award points error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gamification/leaderboard - top users by total points
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 20, 100)

    const { data, error } = await supabase
      .from('gamification_leaderboard')
      .select('*')
      .order('total_points', { ascending: false })
      .limit(limit)

    if (error) throw error

    const userIds = (data || []).map((row) => row.user_id)
    const { data: profiles } = userIds.length
      ? await supabase.from('student_profiles').select('user_id, full_name').in('user_id', userIds)
      : { data: [] as { user_id: string; full_name: string | null }[] }
    const nameByUserId = new Map((profiles || []).map((p) => [p.user_id, p.full_name]))

    const leaderboard = (data || []).map((row, index) => ({
      rank: index + 1,
      display_name: nameByUserId.get(row.user_id) || `${row.user_id.slice(0, 8)}...`,
      total_points: row.total_points,
      actions_count: row.actions_count,
      last_activity_at: row.last_activity_at,
    }))

    res.json({ data: leaderboard })
  } catch (error: any) {
    console.error('Leaderboard error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gamification/badges - list all active badges
router.get('/badges', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('gamification_badges')
      .select('*')
      .eq('is_active', true)
      .order('criteria_threshold', { ascending: true })

    if (error) throw error
    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List badges error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gamification/actions - list all active point-earning actions
// ("how to earn" reference data, mirrors /badges).
router.get('/actions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('gamification_actions')
      .select('*')
      .eq('is_active', true)
      .order('points', { ascending: false })

    if (error) throw error
    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List actions error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gamification/me - current user's point total + earned badges,
// read-only (no side effects). Needed for header/profile displays that show
// state on page load rather than only right after an award.
router.get('/me', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const totalPoints = await totalPointsForUser(userId)

    const { data: earned, error: earnedError } = await supabase
      .from('user_badges')
      .select('badge_id, earned_at, badge:gamification_badges(*)')
      .eq('user_id', userId)
      .order('earned_at', { ascending: false })

    if (earnedError) throw earnedError

    res.json({ total_points: totalPoints, badges: earned || [] })
  } catch (error: any) {
    console.error('Get user gamification state error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
