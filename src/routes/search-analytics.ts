import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'

const router = Router()

// POST /api/analytics/search - fired on every program search (public, anonymous)
router.post('/search', async (req, res) => {
  try {
    const { query, category_id, country_id, level, results_count, user_country } = req.body || {}
    const deviceId = getDeviceFingerprint(req)

    const { error } = await supabase.from('search_analytics').insert({
      query_text: query || null,
      category_id: category_id || null,
      country_filter: country_id || null,
      level_filter: level || null,
      results_count: Number.isFinite(results_count) ? results_count : 0,
      user_country: user_country || null,
      device_id: deviceId,
    })

    if (error) throw error
    res.status(201).json({ success: true })
  } catch (error: any) {
    console.error('Search analytics error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// POST /api/analytics/view - fired when a program detail page is viewed (public, anonymous)
router.post('/view', async (req, res) => {
  try {
    const { program_id, institution_id, user_country, source_query, session_id, view_source } = req.body || {}

    if (!program_id) {
      return res.status(400).json({ success: false, error: 'program_id required' })
    }

    const deviceId = getDeviceFingerprint(req)

    const { error } = await supabase.from('program_views').insert({
      program_id,
      institution_id: institution_id || null,
      device_id: deviceId,
      user_country: user_country || null,
      source_query: source_query || null,
      session_id: session_id || null,
      view_source: view_source || null,
    })

    if (error) throw error
    res.status(201).json({ success: true })
  } catch (error: any) {
    console.error('Program view analytics error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/analytics/university/:id - admin-gated (no per-institution login exists
// yet, so this is reached from /admin/analytics with the shared admin key, same as
// every other /api/admin/analytics/* endpoint).
router.get('/university/:id', adminMiddleware, async (req, res) => {
  try {
    const institutionId = req.params.id
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: programs, error: programsError } = await supabase
      .from('programs')
      .select('id, name')
      .eq('institution_id', institutionId)

    if (programsError) throw programsError
    const nameByProgramId = new Map((programs || []).map((p) => [p.id, p.name]))

    const [{ data: views, error: viewsError }, { data: applications, error: appsError }] = await Promise.all([
      supabase
        .from('program_views')
        .select('program_id, user_country, source_query, created_at')
        .eq('institution_id', institutionId)
        .gte('created_at', thirtyDaysAgo),
      supabase
        .from('program_applications')
        .select('id, institution_application:institution_applications(created_institution_id)')
        .gte('created_at', thirtyDaysAgo),
    ])

    if (viewsError) throw viewsError
    if (appsError) throw appsError

    const applicationsForInstitution = (applications || []).filter(
      (a: any) => a.institution_application?.created_institution_id === institutionId
    )

    const regionalInterest = new Map<string, number>()
    const searchTerms = new Map<string, number>()
    const viewsByProgram = new Map<string, number>()
    const dailyViews = new Map<string, number>()

    for (const view of views || []) {
      const region = view.user_country || 'Unknown'
      regionalInterest.set(region, (regionalInterest.get(region) || 0) + 1)

      if (view.source_query) {
        const term = view.source_query.trim().toLowerCase()
        if (term) searchTerms.set(term, (searchTerms.get(term) || 0) + 1)
      }

      if (view.program_id) viewsByProgram.set(view.program_id, (viewsByProgram.get(view.program_id) || 0) + 1)

      const day = view.created_at.slice(0, 10)
      dailyViews.set(day, (dailyViews.get(day) || 0) + 1)
    }

    const topPrograms = Array.from(viewsByProgram.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([program_id, count]) => ({ program_id, name: nameByProgramId.get(program_id) || 'Unknown program', views: count }))

    const topSearchTerms = Array.from(searchTerms.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([term, count]) => ({ term, count }))

    const regionalInterestRows = Array.from(regionalInterest.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([country, count]) => ({ country, count }))

    const viewsTrend = Array.from(dailyViews.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, count]) => ({ date, count }))

    const totalViews = views?.length || 0
    const totalApplications = applicationsForInstitution.length

    res.json({
      data: {
        institution_id: institutionId,
        period_days: 30,
        total_views: totalViews,
        total_applications: totalApplications,
        conversion_rate: totalViews > 0 ? Math.round((totalApplications / totalViews) * 1000) / 10 : 0,
        top_programs: topPrograms,
        top_search_terms: topSearchTerms,
        regional_interest: regionalInterestRows,
        views_trend: viewsTrend,
      },
    })
  } catch (error: any) {
    console.error('University analytics error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
