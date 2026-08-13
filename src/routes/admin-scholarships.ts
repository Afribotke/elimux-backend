import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/admin/scholarships?page=1&limit=20&status=&application_status=&search=
router.get('/', adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1'))
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20')))
    const from = (page - 1) * limit
    const to = from + limit - 1
    const status = req.query.status as string | undefined
    const applicationStatus = req.query.application_status as string | undefined
    const search = ((req.query.search as string) || '').trim()

    let query = supabase
      .from('scholarships')
      .select('*, provider_sponsor:scholarship_sponsors!provider_id(*), sponsor:scholarship_sponsors!sponsor_id(*)', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)
    if (applicationStatus) query = query.eq('application_status', applicationStatus)
    if (search) query = query.ilike('title', `%${search}%`)

    const { data, error, count } = await query.range(from, to)
    if (error) throw error

    res.json({
      data: data || [],
      meta: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
    })
  } catch (error: any) {
    console.error('GET /api/admin/scholarships error:', error)
    res.status(500).json({ error: error.message || 'Failed to fetch scholarships' })
  }
})

// GET /api/admin/scholarships/:id
router.get('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('scholarships')
      .select(
        '*, provider_sponsor:scholarship_sponsors!provider_id(*), sponsor:scholarship_sponsors!sponsor_id(*), eligibility_criteria:scholarship_eligibility(*), documents:scholarship_documents(*)'
      )
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116' || error.code === '22P02') {
        return res.status(404).json({ error: 'Scholarship not found' })
      }
      throw error
    }

    res.json({ data })
  } catch (error: any) {
    console.error('GET /api/admin/scholarships/:id error:', error)
    res.status(500).json({ error: error.message || 'Failed to fetch scholarship' })
  }
})

// POST /api/admin/scholarships
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const body = req.body || {}

    if (!body.title || !body.provider || !body.application_deadline) {
      return res.status(400).json({ error: 'Missing required fields: title, provider, application_deadline' })
    }

    const scholarshipPayload: Record<string, unknown> = {
      title: body.title,
      provider: body.provider,
      description: body.description,
      eligibility: body.eligibility,
      benefits: body.benefits,
      amount: body.amount,
      currency: body.currency || 'KES',
      coverage_type: body.coverage_type,
      institution_id: body.institution_id || null,
      country_id: body.country_id || null,
      study_levels: body.study_levels || [],
      disciplines: body.disciplines || [],
      target_groups: body.target_groups || [],
      application_opens: body.application_opens || null,
      application_deadline: body.application_deadline,
      notification_date: body.notification_date || null,
      application_url: body.application_url,
      application_process: body.application_process,
      required_documents: body.required_documents || [],
      status: body.status || 'active',
      is_featured: body.is_featured || false,
      source_url: body.source_url,
      provider_id: body.provider_id || null,
      sponsor_id: body.sponsor_id || null,
      funding_amount: body.funding_amount || null,
      duration: body.duration || null,
      duration_unit: body.duration_unit || null,
      is_sponsored: body.is_sponsored || false,
      application_status: body.application_status || 'upcoming',
    }

    const { data: scholarship, error: scholarshipError } = await supabase
      .from('scholarships')
      .insert(scholarshipPayload)
      .select()
      .single()

    if (scholarshipError) throw scholarshipError

    if (Array.isArray(body.eligibility_criteria) && body.eligibility_criteria.length > 0) {
      const records = body.eligibility_criteria.map((e: any) => ({
        scholarship_id: scholarship.id,
        criteria_type: e.criteria_type,
        criteria_value: e.criteria_value,
        is_required: e.is_required,
        description: e.description,
      }))
      const { error: err } = await supabase.from('scholarship_eligibility').insert(records)
      if (err) throw err
    }

    if (Array.isArray(body.documents) && body.documents.length > 0) {
      const records = body.documents.map((d: any) => ({
        scholarship_id: scholarship.id,
        document_name: d.document_name,
        document_description: d.document_description,
        is_required: d.is_required,
        file_type_hint: d.file_type_hint,
        max_file_size_mb: d.max_file_size_mb || 5,
      }))
      const { error: err } = await supabase.from('scholarship_documents').insert(records)
      if (err) throw err
    }

    res.status(201).json({ data: scholarship, message: 'Scholarship created successfully' })
  } catch (error: any) {
    console.error('POST /api/admin/scholarships error:', error)
    res.status(500).json({ error: error.message || 'Failed to create scholarship' })
  }
})

// PUT /api/admin/scholarships/:id
router.put('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body || {}

    const payload: Record<string, unknown> = {
      title: body.title,
      provider: body.provider,
      description: body.description,
      eligibility: body.eligibility,
      benefits: body.benefits,
      amount: body.amount,
      currency: body.currency,
      coverage_type: body.coverage_type,
      institution_id: body.institution_id || null,
      country_id: body.country_id || null,
      study_levels: body.study_levels || [],
      disciplines: body.disciplines || [],
      target_groups: body.target_groups || [],
      application_opens: body.application_opens || null,
      application_deadline: body.application_deadline,
      notification_date: body.notification_date || null,
      application_url: body.application_url,
      application_process: body.application_process,
      required_documents: body.required_documents || [],
      status: body.status,
      is_featured: body.is_featured,
      source_url: body.source_url,
      provider_id: body.provider_id || null,
      sponsor_id: body.sponsor_id || null,
      funding_amount: body.funding_amount || null,
      duration: body.duration || null,
      duration_unit: body.duration_unit || null,
      is_sponsored: body.is_sponsored,
      application_status: body.application_status,
    }

    const { data: scholarship, error } = await supabase
      .from('scholarships')
      .update(payload)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116' || error.code === '22P02') {
        return res.status(404).json({ error: 'Scholarship not found' })
      }
      throw error
    }

    await supabase.from('scholarship_eligibility').delete().eq('scholarship_id', id)
    if (Array.isArray(body.eligibility_criteria) && body.eligibility_criteria.length > 0) {
      const records = body.eligibility_criteria.map((e: any) => ({
        scholarship_id: id,
        criteria_type: e.criteria_type,
        criteria_value: e.criteria_value,
        is_required: e.is_required,
        description: e.description,
      }))
      const { error: err } = await supabase.from('scholarship_eligibility').insert(records)
      if (err) throw err
    }

    await supabase.from('scholarship_documents').delete().eq('scholarship_id', id)
    if (Array.isArray(body.documents) && body.documents.length > 0) {
      const records = body.documents.map((d: any) => ({
        scholarship_id: id,
        document_name: d.document_name,
        document_description: d.document_description,
        is_required: d.is_required,
        file_type_hint: d.file_type_hint,
        max_file_size_mb: d.max_file_size_mb || 5,
      }))
      const { error: err } = await supabase.from('scholarship_documents').insert(records)
      if (err) throw err
    }

    res.json({ data: scholarship, message: 'Scholarship updated successfully' })
  } catch (error: any) {
    console.error('PUT /api/admin/scholarships/:id error:', error)
    res.status(500).json({ error: error.message || 'Failed to update scholarship' })
  }
})

// DELETE /api/admin/scholarships/:id
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase.from('scholarships').delete().eq('id', id)
    if (error) throw error
    res.json({ message: 'Scholarship deleted successfully' })
  } catch (error: any) {
    console.error('DELETE /api/admin/scholarships/:id error:', error)
    res.status(500).json({ error: error.message || 'Failed to delete scholarship' })
  }
})

export default router
