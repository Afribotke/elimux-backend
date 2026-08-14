import { Router, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { requireUser, UserAuthRequest } from '../middleware/user-auth'
import { uploadScholarshipDocument, deleteScholarshipDocument } from '../services/documentUpload'
import { getApplicationGuidance, checkGuidanceRateLimit } from '../services/aiApplicationAdvisor'

const router = Router()
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/scholarship-applications/start
router.post('/start', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { scholarship_id } = req.body

    if (!scholarship_id) {
      return res.status(400).json({ error: 'scholarship_id required' })
    }

    const { data: scholarship, error: schError } = await supabase
      .from('scholarships')
      .select('id, title, documents:scholarship_documents(*)')
      .eq('id', scholarship_id)
      .eq('status', 'active')
      .eq('application_status', 'open')
      .single()

    if (schError || !scholarship) {
      return res.status(404).json({ error: 'Scholarship not found or not open' })
    }

    const requiredDocs = (scholarship.documents || [])
      .filter((d: any) => d.is_required)
      .map((d: any) => d.document_name)

    const { data: application, error } = await supabase
      .from('scholarship_applications')
      .insert({
        student_id: userId,
        scholarship_id,
        status: 'draft',
        documents_uploaded: [],
        missing_documents: requiredDocs,
      })
      .select('*, scholarship:scholarships(*)')
      .single()

    if (error) {
      // scholarship_applications_student_id_scholarship_id_key
      if ((error as any).code === '23505') {
        const { data: existing } = await supabase
          .from('scholarship_applications')
          .select('id, status')
          .eq('student_id', userId)
          .eq('scholarship_id', scholarship_id)
          .single()
        return res.status(409).json({ error: 'Application already exists', application: existing })
      }
      throw error
    }

    res.status(201).json({ data: application })
  } catch (error: any) {
    console.error('Start application error:', error)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/scholarship-applications
router.get('/', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('scholarship_applications')
      .select('*, scholarship:scholarships(*)')
      .eq('student_id', req.userId)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ data })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/scholarship-applications/:id
router.get('/:id', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('scholarship_applications')
      .select('*, scholarship:scholarships(*, documents:scholarship_documents(*), eligibility:scholarship_eligibility(*))')
      .eq('id', id)
      .eq('student_id', req.userId)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Application not found' })
    res.json({ data })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/scholarship-applications/:id/upload
// Body: { file: base64, document_name, mime_type }. The app-wide json body
// limit (index.ts) is 8mb to cover this route's base64-inflated payloads -
// see the comment there.
router.post('/:id/upload', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const id = req.params.id as string

    const { data: application, error: appError } = await supabase
      .from('scholarship_applications')
      .select('*')
      .eq('id', id)
      .eq('student_id', userId)
      .single()

    if (appError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    const { file, document_name, mime_type } = req.body
    if (!file || !document_name) {
      return res.status(400).json({ error: 'file and document_name required' })
    }

    const fileBuffer = Buffer.from(file, 'base64')
    const mimeType = mime_type || 'application/pdf'

    const result = await uploadScholarshipDocument(fileBuffer, document_name, mimeType, fileBuffer.length, userId, id)

    const currentDocs = application.documents_uploaded || []
    const updatedDocs = [...currentDocs, { name: document_name, path: result.path, uploaded_at: new Date().toISOString() }]

    const currentMissing: string[] = application.missing_documents || []
    const updatedMissing = currentMissing.filter((m: string) => m !== document_name)

    const { data: updated, error } = await supabase
      .from('scholarship_applications')
      .update({ documents_uploaded: updatedDocs, missing_documents: updatedMissing })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    res.json({ data: updated, upload: result })
  } catch (error: any) {
    console.error('Upload error:', error)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/scholarship-applications/:id/submit
router.post('/:id/submit', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { id } = req.params

    const { data: application, error: fetchError } = await supabase
      .from('scholarship_applications')
      .select('*')
      .eq('id', id)
      .eq('student_id', userId)
      .single()

    if (fetchError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    const missing = application.missing_documents || []
    if (missing.length > 0) {
      return res.status(400).json({ error: 'Cannot submit: missing required documents', missing_documents: missing })
    }

    const { data, error } = await supabase
      .from('scholarship_applications')
      .update({ status: 'submitted', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    res.json({ data })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/scholarship-applications/:id/guidance
// Cached in scholarship_applications.ai_guidance - pass { force: true } to
// regenerate. Rate-limited per-student since this calls a paid LLM.
router.post('/:id/guidance', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { id } = req.params
    const force = req.body?.force === true

    const { data: application, error: fetchError } = await supabase
      .from('scholarship_applications')
      .select('*, scholarship:scholarships(*)')
      .eq('id', id)
      .eq('student_id', userId)
      .single()

    if (fetchError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    if (application.ai_guidance && !force) {
      return res.json({ data: { guidance: application.ai_guidance, cached: true } })
    }

    const rateLimit = checkGuidanceRateLimit(userId)
    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: 'Too many guidance requests. Please try again later.',
        retry_after_ms: rateLimit.retryAfterMs,
      })
    }

    const guidance = await getApplicationGuidance(application, application.scholarship)

    await supabase.from('scholarship_applications').update({ ai_guidance: guidance }).eq('id', id)

    res.json({ data: { guidance, cached: false } })
  } catch (error: any) {
    console.error('Guidance error:', error)
    res.status(502).json({ error: error.message || 'Guidance generation failed' })
  }
})

// DELETE /api/scholarship-applications/:id
router.delete('/:id', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const userId = req.userId!
    const { id } = req.params

    const { data: application } = await supabase
      .from('scholarship_applications')
      .select('documents_uploaded')
      .eq('id', id)
      .eq('student_id', userId)
      .single()

    if (application?.documents_uploaded) {
      for (const doc of application.documents_uploaded) {
        if (doc.path) await deleteScholarshipDocument(doc.path)
      }
    }

    const { error } = await supabase
      .from('scholarship_applications')
      .delete()
      .eq('id', id)
      .eq('student_id', userId)

    if (error) throw error
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

export default router
