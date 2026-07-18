import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'
import { TRACKABLE_EVENT_TYPES, periodStarts, getUniqueDeviceIds, dayKey } from '../lib/analytics'

const router = Router()

// POST /api/admin/analytics/track - despite the /admin/ prefix (kept to match the
// spec's URL), this is deliberately PUBLIC and not behind adminMiddleware: it exists
// to record anonymous visitor behavior (searches, page views, clicks...), which by
// definition can't carry an admin key. The 5 GET endpoints below are the actual
// admin-only surface.
router.post('/track', async (req, res) => {
  try {
    const { event_type, user_device_id, metadata } = req.body || {}

    if (!TRACKABLE_EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: 'Invalid event_type', allowed: TRACKABLE_EVENT_TYPES })
    }

    const deviceId = user_device_id || getDeviceFingerprint(req)

    const { data, error } = await supabase
      .from('analytics_events')
      .insert({ event_type, user_device_id: deviceId, metadata: metadata ?? null })
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ data })
  } catch (error: any) {
    console.error('Track event error:', error)
    res.status(500).json({ error: 'Failed to track event' })
  }
})

// GET /api/admin/analytics/overview
router.get('/overview', adminMiddleware, async (req, res) => {
  try {
    const { today, week, month } = periodStarts()

    const [
      deviceIds,
      { count: searchesToday },
      { count: searchesWeek },
      { count: searchesMonth },
      { data: successfulPayments },
      { count: totalReviews },
      { count: totalInstitutionApplications },
      { count: totalProgramApplications },
    ] = await Promise.all([
      getUniqueDeviceIds(),
      supabase.from('analytics_events').select('id', { count: 'exact', head: true }).eq('event_type', 'search').gte('created_at', today),
      supabase.from('analytics_events').select('id', { count: 'exact', head: true }).eq('event_type', 'search').gte('created_at', week),
      supabase.from('analytics_events').select('id', { count: 'exact', head: true }).eq('event_type', 'search').gte('created_at', month),
      supabase.from('payments').select('amount').eq('status', 'success').eq('currency', 'KES'),
      supabase.from('reviews').select('id', { count: 'exact', head: true }),
      supabase.from('institution_applications').select('id', { count: 'exact', head: true }),
      supabase.from('program_applications').select('id', { count: 'exact', head: true }),
    ])

    const totalRevenueKes = (successfulPayments || []).reduce((sum, p: any) => sum + (p.amount || 0), 0)
    const institutionApplications = totalInstitutionApplications || 0
    const programApplications = totalProgramApplications || 0

    res.json({
      data: {
        total_users: deviceIds.size,
        total_searches: { today: searchesToday || 0, week: searchesWeek || 0, month: searchesMonth || 0 },
        total_revenue_kes: totalRevenueKes,
        total_reviews: totalReviews || 0,
        total_applications: {
          institution_applications: institutionApplications,
          program_applications: programApplications,
          total: institutionApplications + programApplications,
        },
      },
    })
  } catch (error: any) {
    console.error('Analytics overview error:', error)
    res.status(500).json({ error: 'Failed to load analytics overview' })
  }
})

// GET /api/admin/analytics/revenue
router.get('/revenue', adminMiddleware, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [
      { data: activeSubs, error: subsError },
      { data: successfulPayments, error: paymentsError },
      { data: paymentHistory, error: historyError },
      { data: paidAdPayments, error: adRevenueError },
      { data: adPaymentHistory, error: adHistoryError },
    ] = await Promise.all([
      supabase.from('subscriptions').select('plan:subscription_plans(price_kes, duration_months)').eq('status', 'active'),
      supabase.from('payments').select('amount, subscription:subscriptions(plan:subscription_plans(name))').eq('status', 'success'),
      supabase
        .from('payments')
        .select('id, amount, currency, status, payment_method, created_at, subscriber:subscribers(email), subscription:subscriptions(plan:subscription_plans(name))')
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false }),
      // Ad revenue: completed wallet top-ups from the advertiser portal
      supabase.from('ad_payments').select('amount, created_at').eq('status', 'paid'),
      supabase
        .from('ad_payments')
        .select('id, amount, status, paystack_reference, created_at, advertiser:advertisers(organization_name, email)')
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false }),
    ])

    if (subsError) throw subsError
    if (paymentsError) throw paymentsError
    if (historyError) throw historyError
    if (adRevenueError) throw adRevenueError
    if (adHistoryError) throw adHistoryError

    const mrr = (activeSubs || []).reduce((sum: number, s: any) => {
      const plan = s.plan
      if (!plan?.price_kes) return sum
      return sum + plan.price_kes / (plan.duration_months || 1)
    }, 0)

    const revenueByPlan: Record<string, number> = {}
    for (const p of successfulPayments || []) {
      const planName = (p as any).subscription?.plan?.name || 'Unknown'
      revenueByPlan[planName] = (revenueByPlan[planName] || 0) + (p.amount || 0)
    }

    const adRevenueTotal = (paidAdPayments || []).reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0)
    const adRevenue30d = (paidAdPayments || [])
      .filter((p: any) => p.created_at >= thirtyDaysAgo)
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0)

    res.json({
      data: {
        mrr_kes: Math.round(mrr),
        revenue_by_plan: Object.entries(revenueByPlan).map(([plan, revenue_kes]) => ({ plan, revenue_kes })),
        payment_history: paymentHistory || [],
        ad_revenue_total_kes: adRevenueTotal,
        ad_revenue_30d_kes: adRevenue30d,
        ad_payment_history: adPaymentHistory || [],
      },
    })
  } catch (error: any) {
    console.error('Analytics revenue error:', error)
    res.status(500).json({ error: 'Failed to load revenue analytics' })
  }
})

// GET /api/admin/analytics/users - optional ?level=none|low|medium|high
router.get('/users', adminMiddleware, async (req, res) => {
  try {
    const { level } = req.query

    const [{ data: favorites }, { data: points }, { data: events }] = await Promise.all([
      supabase.from('user_favorites').select('device_id, created_at'),
      supabase.from('gamification_points').select('device_id, created_at'),
      supabase.from('analytics_events').select('user_device_id, created_at'),
    ])

    const byDevice = new Map<string, { activity_count: number; last_active: string }>()

    function touch(deviceId: string | null, createdAt: string) {
      if (!deviceId) return
      const existing = byDevice.get(deviceId)
      if (!existing) {
        byDevice.set(deviceId, { activity_count: 1, last_active: createdAt })
      } else {
        existing.activity_count += 1
        if (createdAt > existing.last_active) existing.last_active = createdAt
      }
    }

    for (const row of favorites || []) touch(row.device_id, row.created_at)
    for (const row of points || []) touch(row.device_id, row.created_at)
    for (const row of events || []) touch(row.user_device_id, row.created_at)

    function activityLevel(count: number): 'none' | 'low' | 'medium' | 'high' {
      if (count === 0) return 'none'
      if (count < 5) return 'low'
      if (count < 20) return 'medium'
      return 'high'
    }

    let users = Array.from(byDevice.entries()).map(([device_id, stats]) => ({
      device_id,
      activity_count: stats.activity_count,
      activity_level: activityLevel(stats.activity_count),
      last_active: stats.last_active,
    }))

    users.sort((a, b) => (a.last_active < b.last_active ? 1 : -1))

    if (level && typeof level === 'string') {
      users = users.filter((u) => u.activity_level === level)
    }

    res.json({ data: users, meta: { total: users.length } })
  } catch (error: any) {
    console.error('Analytics users error:', error)
    res.status(500).json({ error: 'Failed to load user analytics' })
  }
})

// GET /api/admin/analytics/searches
router.get('/searches', adminMiddleware, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: searchEvents, error } = await supabase
      .from('analytics_events')
      .select('metadata, created_at')
      .eq('event_type', 'search')
      .gte('created_at', thirtyDaysAgo)

    if (error) throw error

    const termCounts = new Map<string, number>()
    const zeroResultCounts = new Map<string, number>()
    const dailyCounts = new Map<string, number>()

    for (const event of searchEvents || []) {
      const meta = (event.metadata || {}) as { query?: string; result_count?: number }
      const term = meta.query?.trim().toLowerCase()

      dailyCounts.set(dayKey(event.created_at), (dailyCounts.get(dayKey(event.created_at)) || 0) + 1)

      if (!term) continue
      termCounts.set(term, (termCounts.get(term) || 0) + 1)
      if (meta.result_count === 0) zeroResultCounts.set(term, (zeroResultCounts.get(term) || 0) + 1)
    }

    const popularTerms = Array.from(termCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([term, count]) => ({ term, count }))

    const zeroResultSearches = Array.from(zeroResultCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([term, count]) => ({ term, count }))

    const trend = Array.from(dailyCounts.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, count]) => ({ date, count }))

    res.json({ data: { popular_terms: popularTerms, zero_result_searches: zeroResultSearches, trend } })
  } catch (error: any) {
    console.error('Analytics searches error:', error)
    res.status(500).json({ error: 'Failed to load search analytics' })
  }
})

// GET /api/admin/analytics/institutions
router.get('/institutions', adminMiddleware, async (req, res) => {
  try {
    const [{ data: viewEvents, error: viewsError }, { data: applications, error: appsError }, { data: reviews, error: reviewsError }] = await Promise.all([
      supabase.from('analytics_events').select('metadata').eq('event_type', 'page_view'),
      supabase
        .from('program_applications')
        .select('institution_application:institution_applications(created_institution_id)'),
      supabase.from('reviews').select('institution_id, rating'),
    ])

    if (viewsError) throw viewsError
    if (appsError) throw appsError
    if (reviewsError) throw reviewsError

    const viewCounts = new Map<string, number>()
    for (const event of viewEvents || []) {
      const institutionId = (event.metadata as { institution_id?: string } | null)?.institution_id
      if (institutionId) viewCounts.set(institutionId, (viewCounts.get(institutionId) || 0) + 1)
    }

    const applicationCounts = new Map<string, number>()
    for (const app of applications || []) {
      const institutionId = (app as any).institution_application?.created_institution_id
      if (institutionId) applicationCounts.set(institutionId, (applicationCounts.get(institutionId) || 0) + 1)
    }

    const reviewCounts = new Map<string, { count: number; ratingSum: number }>()
    for (const review of reviews || []) {
      if (!review.institution_id) continue
      const existing = reviewCounts.get(review.institution_id) || { count: 0, ratingSum: 0 }
      existing.count += 1
      existing.ratingSum += review.rating || 0
      reviewCounts.set(review.institution_id, existing)
    }

    const institutionIds = new Set([...viewCounts.keys(), ...applicationCounts.keys(), ...reviewCounts.keys()])
    const { data: institutions } = institutionIds.size
      ? await supabase.from('institutions').select('id, name').in('id', Array.from(institutionIds))
      : { data: [] as { id: string; name: string }[] }
    const nameById = new Map((institutions || []).map((i) => [i.id, i.name]))

    function topN(counts: Map<string, number>, n = 10) {
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([institution_id, count]) => ({ institution_id, name: nameById.get(institution_id) || 'Unknown institution', count }))
    }

    const byReviews = Array.from(reviewCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([institution_id, stats]) => ({
        institution_id,
        name: nameById.get(institution_id) || 'Unknown institution',
        count: stats.count,
        avg_rating: stats.count > 0 ? Math.round((stats.ratingSum / stats.count) * 10) / 10 : 0,
      }))

    res.json({
      data: {
        by_page_views: topN(viewCounts),
        by_applications: topN(applicationCounts),
        by_reviews: byReviews,
      },
    })
  } catch (error: any) {
    console.error('Analytics institutions error:', error)
    res.status(500).json({ error: 'Failed to load institution analytics' })
  }
})

export default router
