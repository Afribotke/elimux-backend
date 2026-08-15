import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { adminMiddleware } from '../middleware/auth'
import {
  sendEmail,
  scholarshipAwardedEmailHtml,
  scholarshipAwardedEmailSubject,
  scholarshipRejectedEmailHtml,
  scholarshipRejectedEmailSubject,
} from '../lib/email'

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

    const applications = data || []

    // No FK between scholarship_applications.student_id and student_profiles
    // (student_id matches student_profiles.user_id in practice, but there's
    // no constraint), so PostgREST can't embed `student:student_profiles(...)`
    // - fetch profiles separately and merge instead.
    const studentIds = [...new Set(applications.map((a: any) => a.student_id).filter(Boolean))]
    let studentsById: Record<string, any> = {}
    if (studentIds.length > 0) {
      const { data: profiles } = await supabase
        .from('student_profiles')
        .select('user_id, full_name, email, university_name, course_name, year_of_study')
        .in('user_id', studentIds)
      studentsById = Object.fromEntries((profiles || []).map((p: any) => [p.user_id, p]))
    }

    const withStudents = applications.map((a: any) => ({
      ...a,
      student: studentsById[a.student_id] || null,
    }))

    res.json({ data: withStudents, total: count || 0 })
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

    // Final-outcome notification only - 'under_review' is an intermediate
    // status change with nothing decided yet to tell the student. Never
    // lets an email failure fail the review itself (same contract as the
    // institution-application approve/reject emails in admin.ts).
    if ((status === 'awarded' || status === 'rejected') && data.scholarship?.title) {
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(data.student_id)
        const studentEmail = userData?.user?.email
        if (studentEmail) {
          const studentName = userData?.user?.user_metadata?.full_name || 'there'
          const scholarshipTitle = data.scholarship.title
          const notes = review_notes || undefined

          await sendEmail(
            status === 'awarded'
              ? {
                  to: studentEmail,
                  subject: scholarshipAwardedEmailSubject(scholarshipTitle),
                  html: scholarshipAwardedEmailHtml({ studentName, scholarshipTitle, reviewNotes: notes }),
                }
              : {
                  to: studentEmail,
                  subject: scholarshipRejectedEmailSubject(scholarshipTitle),
                  html: scholarshipRejectedEmailHtml({ studentName, scholarshipTitle, reviewNotes: notes }),
                }
          )
        }
      } catch (emailError: any) {
        console.error('Scholarship review notification error:', emailError)
      }
    }

    res.json({ data })
  } catch (error: any) {
    console.error('Admin review error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/admin/scholarship-applications/:id/document/:docName
// Returns a fresh signed URL for admins to view a specific uploaded document
router.get('/:id/document/:docName', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { id, docName } = req.params

    const { data: application, error: appError } = await supabase
      .from('scholarship_applications')
      .select('student_id, documents_uploaded')
      .eq('id', id)
      .single()

    if (appError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    const doc = application.documents_uploaded?.find((d: any) => d.name === decodeURIComponent(String(docName)))
    if (!doc?.path) {
      return res.status(404).json({ error: 'Document not found' })
    }

    const { data: signedUrl, error: urlError } = await supabase
      .storage
      .from('scholarship-documents')
      .createSignedUrl(doc.path, 3600) // 1 hour

    if (urlError) throw urlError

    res.json({ url: signedUrl?.signedUrl })
  } catch (error: any) {
    console.error('Admin document URL error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
