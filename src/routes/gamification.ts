import { Router } from 'express'
import crypto from 'crypto'
import { supabase } from '../lib/supabase'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'

const router = Router()

// Server-controlled point values per action - the client only ever sends
// action_type, never a point amount, so a device can't self-award arbitrary
// points on the leaderboard. Must match gamification_points_action_type_check
// in the DB exactly - it only accepts these five values.
const ACTION_POINTS: Record<string, number> = {
  search: 1,
  review: 10,
  share: 5,
  referral: 50,
  login: 1,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function totalPointsForDevice(deviceId: string): Promise<number> {
  const { data, error } = await supabase
    .from('gamification_leaderboard')
    .select('total_points')
    .eq('device_id', deviceId)
    .maybeSingle()

  if (error) throw error
  return data?.total_points ?? 0
}

// Awards any active points_total badges the device now qualifies for and
// hasn't already earned. Badges with any other criteria_type are left for
// manual/future evaluation - the schema only carries a threshold, not which
// action it applies to, so points_total is the one kind this can judge.
async function awardEligibleBadges(deviceId: string, totalPoints: number) {
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
    .eq('device_id', deviceId)
    .in('badge_id', badges.map((b) => b.id))

  if (earnedError) throw earnedError

  const earnedIds = new Set((alreadyEarned || []).map((b) => b.badge_id))
  const newlyEligible = badges.filter((b) => !earnedIds.has(b.id))
  if (newlyEligible.length === 0) return []

  const { error: insertBadgesError } = await supabase
    .from('user_badges')
    .insert(newlyEligible.map((b) => ({ badge_id: b.id, device_id: deviceId })))

  if (insertBadgesError) throw insertBadgesError

  // Badge bonus points now land in the ledger under the 'badge' action type
  // (added in migration 23). Clients can't self-award these - 'badge' is not
  // in ACTION_POINTS, so the /points endpoint rejects it; only this server
  // path can create badge entries.
  const bonusRows = newlyEligible
    .filter((b) => b.points_reward && b.points_reward > 0)
    .map((b) => ({
      device_id: deviceId,
      action_type: 'badge',
      points_earned: b.points_reward,
      metadata: { badge_id: b.id, badge_name: b.name },
    }))

  if (bonusRows.length > 0) {
    const { error: bonusError } = await supabase.from('gamification_points').insert(bonusRows)
    if (bonusError) throw bonusError
  }

  return newlyEligible
}

// POST /api/gamification/points - award points for an action
router.post('/points', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)
    const { action_type, metadata, display_name, email } = req.body

    if (!action_type || !(action_type in ACTION_POINTS)) {
      return res.status(400).json({
        error: 'Invalid action_type',
        allowed: Object.keys(ACTION_POINTS),
      })
    }

    const mergedMetadata: Record<string, unknown> = isPlainObject(metadata) ? { ...metadata } : {}
    if (display_name) mergedMetadata.display_name = String(display_name).slice(0, 60)
    if (email) mergedMetadata.email = String(email).slice(0, 255)

    const { data, error } = await supabase
      .from('gamification_points')
      .insert({
        device_id: deviceId,
        action_type,
        points_earned: ACTION_POINTS[action_type],
        metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : null,
      })
      .select()
      .single()

    if (error) throw error

    const totalPoints = await totalPointsForDevice(deviceId)
    const badgesEarned = await awardEligibleBadges(deviceId, totalPoints)

    res.status(201).json({
      data,
      total_points: badgesEarned.length > 0 ? await totalPointsForDevice(deviceId) : totalPoints,
      badges_earned: badgesEarned,
    })
  } catch (error: any) {
    console.error('Award points error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gamification/leaderboard - top devices by total points
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 20, 100)

    const { data, error } = await supabase
      .from('gamification_leaderboard')
      .select('*')
      .order('total_points', { ascending: false })
      .limit(limit)

    if (error) throw error

    const leaderboard = (data || []).map((row, index) => ({
      rank: index + 1,
      display_name: row.display_name || `${row.device_id.slice(0, 8)}...`,
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

// GET /api/gamification/me - current device's point total + earned badges,
// read-only (no side effects). Needed for header/profile displays that show
// state on page load rather than only right after an award.
router.get('/me', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)
    const totalPoints = await totalPointsForDevice(deviceId)

    const { data: earned, error: earnedError } = await supabase
      .from('user_badges')
      .select('badge_id, earned_at, badge:gamification_badges(*)')
      .eq('device_id', deviceId)
      .order('earned_at', { ascending: false })

    if (earnedError) throw earnedError

    res.json({ total_points: totalPoints, badges: earned || [] })
  } catch (error: any) {
    console.error('Get device gamification state error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function generateReferralCode(): string {
  return `ELX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

// POST /api/gamification/referrals - two modes:
//  - { referrer_email } creates (or returns the existing pending) code to share
//  - { referrer_code, referred_email } redeems a code someone was given
router.post('/referrals', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req)
    const { referrer_email, referrer_code, referred_email } = req.body

    if (referrer_code) {
      if (!referred_email || !String(referred_email).includes('@')) {
        return res.status(400).json({ error: 'Valid referred_email required to redeem a code' })
      }

      const code = String(referrer_code).toUpperCase()
      const { data: referral, error: fetchError } = await supabase
        .from('referrals')
        .select('*')
        .eq('referrer_code', code)
        .maybeSingle()

      if (fetchError) throw fetchError
      if (!referral) return res.status(404).json({ error: 'Referral code not found' })
      if (referral.status === 'completed') {
        return res.status(400).json({ error: 'Referral code already used' })
      }
      if (referral.referrer_email.toLowerCase() === String(referred_email).toLowerCase()) {
        return res.status(400).json({ error: 'Cannot refer yourself' })
      }

      const { data, error } = await supabase
        .from('referrals')
        .update({
          referred_email,
          status: 'completed',
          reward_given: true,
          completed_at: new Date().toISOString(),
        })
        .eq('id', referral.id)
        .select()
        .single()

      if (error) throw error

      // Pay the referrer: points go to the device that created the code
      // (referrals are email-keyed; points are device-keyed - migration 22
      // added the attribution column that makes this payout possible).
      let referral_points_awarded = false
      if (referral.referrer_device_id) {
        const { error: ptsError } = await supabase.from('gamification_points').insert({
          device_id: referral.referrer_device_id,
          action_type: 'referral',
          points_earned: ACTION_POINTS.referral,
          metadata: { referred_email },
        })
        if (ptsError) throw ptsError
        referral_points_awarded = true

        const referrerTotal = await totalPointsForDevice(referral.referrer_device_id)
        await awardEligibleBadges(referral.referrer_device_id, referrerTotal)
      }

      return res.json({ data, message: 'Referral completed', referral_points_awarded })
    }

    if (!referrer_email || !String(referrer_email).includes('@')) {
      return res.status(400).json({ error: 'Valid referrer_email required' })
    }

    const { data: existing, error: existingError } = await supabase
      .from('referrals')
      .select('*')
      .eq('referrer_email', referrer_email)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .maybeSingle()

    if (existingError) throw existingError
    if (existing) return res.status(200).json({ data: existing, message: 'Existing referral code' })

    let created = null
    let lastError: any = null
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const { data, error } = await supabase
        .from('referrals')
        .insert({ referrer_email, referrer_code: generateReferralCode(), referrer_device_id: deviceId })
        .select()
        .single()

      if (!error) {
        created = data
      } else if (error.code === '23505') {
        lastError = error
        continue // code collision, retry with a new one
      } else {
        throw error
      }
    }

    if (!created) throw lastError || new Error('Failed to generate a unique referral code')

    res.status(201).json({ data: created, message: 'Referral code created' })
  } catch (error: any) {
    console.error('Create referral error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/gamification/referrals/:code - check a referral's status
router.get('/referrals/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase()

    const { data, error } = await supabase
      .from('referrals')
      .select('*')
      .eq('referrer_code', code)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Referral code not found' })

    res.json({ data })
  } catch (error: any) {
    console.error('Check referral error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
