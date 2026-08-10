import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/admin/dashboard/stats — entity counts + 30-day growth for the
// admin overview page. Deliberately excludes a "total users" figure: real
// accounts live in auth.users, which has no cheap count endpoint, and
// public.users is an unused legacy table (always 0 rows) that would lie.
router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [
      { count: institutions },
      { count: programs },
      { count: employers },
      { count: internships },
      { count: reviews },
      { count: attachments },
      { count: contactMessages },
      { count: openNitaFlags },
      { count: newInstitutions },
      { count: newEmployers },
      { count: newInternships },
    ] = await Promise.all([
      supabase.from('institutions').select('id', { count: 'exact', head: true }),
      supabase.from('programs').select('id', { count: 'exact', head: true }),
      supabase.from('employers').select('id', { count: 'exact', head: true }),
      supabase.from('internships').select('id', { count: 'exact', head: true }),
      supabase.from('reviews').select('id', { count: 'exact', head: true }),
      supabase.from('attachments').select('id', { count: 'exact', head: true }),
      supabase.from('contact_messages').select('id', { count: 'exact', head: true }),
      supabase.from('nita_compliance_flags').select('id', { count: 'exact', head: true }).eq('resolved', false),
      supabase.from('institutions').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
      supabase.from('employers').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
      supabase.from('internships').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
    ])

    const [{ data: recentMessages }, { data: recentInstitutions }] = await Promise.all([
      supabase
        .from('contact_messages')
        .select('id, name, email, subject, created_at')
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('institutions')
        .select('id, name, country, created_at')
        .order('created_at', { ascending: false })
        .limit(5),
    ])

    res.json({
      data: {
        totals: {
          institutions: institutions || 0,
          programs: programs || 0,
          employers: employers || 0,
          internships: internships || 0,
          reviews: reviews || 0,
          attachments: attachments || 0,
          contact_messages: contactMessages || 0,
          open_nita_flags: openNitaFlags || 0,
        },
        growth_30d: {
          institutions: newInstitutions || 0,
          employers: newEmployers || 0,
          internships: newInternships || 0,
        },
        recent: {
          contact_messages: recentMessages || [],
          institutions: recentInstitutions || [],
        },
      },
    })
  } catch (err: any) {
    console.error('Admin dashboard stats error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/dashboard/audit-log — reads the existing (currently
// unwritten) activity_log table. No route in this codebase writes to it yet,
// so this may return an empty page in production; that's the accurate state,
// not a bug in this endpoint.
router.get('/audit-log', adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1'))
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50')))
    const offset = (page - 1) * limit

    const { data, error, count } = await supabase
      .from('activity_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error
    res.json({ data: data || [], total: count || 0, page })
  } catch (err: any) {
    console.error('Admin audit log error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/dashboard/nita — read-only rollup of open NITA compliance
// flags for platform admins. Deliberately does not duplicate the resolve
// workflow: NITA officers already manage flags through their own portal
// (/nita/*, gated by requireNitaAdmin in src/routes/nita.ts). This just
// gives platform admins visibility without a second write path on the same
// rows.
router.get('/nita', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nita_compliance_flags')
      .select('*, employer:employer_id(id, company_name, nita_employer_number, user_id)')
      .eq('resolved', false)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ data: data || [] })
  } catch (err: any) {
    console.error('Admin NITA flags error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
