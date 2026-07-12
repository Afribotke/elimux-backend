import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/admin/verify - lightweight key check the frontend's admin gate
// calls before showing the dashboard. Reuses the same check every other
// admin-protected route already applies, so a key that passes here is
// guaranteed to also work for real CRUD operations (and vice versa).
router.get('/verify', adminMiddleware, (req, res) => {
  res.json({ valid: true })
})

// GET /api/admin/plans — list all plans, including inactive, with active subscriber counts
router.get('/plans', adminMiddleware, async (req, res) => {
  try {
    const { data: plans, error } = await supabase
      .from('subscription_plans')
      .select('*')
      .order('price_kes', { ascending: true })

    if (error) throw error

    const withCounts = await Promise.all(
      (plans || []).map(async (plan) => {
        const { count } = await supabase
          .from('subscriptions')
          .select('*', { count: 'exact', head: true })
          .eq('plan_id', plan.id)
          .eq('status', 'active')

        return { ...plan, subscriber_count: count || 0 }
      })
    )

    res.json({ data: withCounts })
  } catch (error: any) {
    console.error('List admin plans error:', error)
    res.status(500).json({ error: 'Failed to fetch plans' })
  }
})

// POST /api/admin/plans — create a new plan
router.post('/plans', adminMiddleware, async (req, res) => {
  try {
    const { name, slug, description, price_kes, price_usd, currency, duration_months, features, is_active } = req.body

    if (!name || !slug || price_kes === undefined || price_kes === null) {
      return res.status(400).json({ error: 'Missing required fields', required: ['name', 'slug', 'price_kes'] })
    }

    const { data, error } = await supabase
      .from('subscription_plans')
      .insert({
        name,
        slug,
        description: description || null,
        price_kes: Number(price_kes),
        price_usd: price_usd !== undefined && price_usd !== null && price_usd !== '' ? Number(price_usd) : null,
        currency: currency || 'KES',
        duration_months: duration_months ? Number(duration_months) : 1,
        features: features ?? null,
        is_active: is_active ?? true,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating plan:', error)
      return res.status(500).json({ error: 'Failed to create plan', details: error.message })
    }

    res.status(201).json({ data, message: 'Plan created successfully' })
  } catch (error: any) {
    console.error('Create plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/admin/plans/:id — update plan details
router.put('/plans/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { name, slug, description, price_kes, price_usd, currency, duration_months, features, is_active } = req.body

    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name
    if (slug !== undefined) updates.slug = slug
    if (description !== undefined) updates.description = description
    if (price_kes !== undefined) updates.price_kes = Number(price_kes)
    if (price_usd !== undefined) updates.price_usd = price_usd === null || price_usd === '' ? null : Number(price_usd)
    if (currency !== undefined) updates.currency = currency
    if (duration_months !== undefined) updates.duration_months = Number(duration_months)
    if (features !== undefined) updates.features = features
    if (is_active !== undefined) updates.is_active = is_active

    const { data, error } = await supabase
      .from('subscription_plans')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating plan:', error)
      return res.status(500).json({ error: 'Failed to update plan', details: error.message })
    }

    res.json({ data, message: 'Plan updated successfully' })
  } catch (error: any) {
    console.error('Update plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/admin/plans/:id — soft delete (is_active = false)
router.delete('/plans/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('subscription_plans')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error deactivating plan:', error)
      return res.status(500).json({ error: 'Failed to deactivate plan', details: error.message })
    }

    res.json({ data, message: 'Plan deactivated successfully' })
  } catch (error: any) {
    console.error('Deactivate plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/admin/applications — list institution applications with their program applications
router.get('/applications', adminMiddleware, async (req, res) => {
  try {
    const { status } = req.query

    let query = supabase
      .from('institution_applications')
      .select('*, type:institution_types(name), country:countries(name), programs:program_applications(*)')
      .order('submitted_at', { ascending: false })

    if (status) query = query.eq('status', status as string)

    const { data, error } = await query

    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List applications error:', error)
    res.status(500).json({ error: 'Failed to fetch applications' })
  }
})

// POST /api/admin/applications/:id/approve — create the real institution (and any
// pending programs submitted alongside it), then mark the application approved.
router.post('/applications/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { admin_notes } = req.body

    const { data: application, error: fetchError } = await supabase
      .from('institution_applications')
      .select('*, programs:program_applications(*)')
      .eq('id', id)
      .single()

    if (fetchError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    if (application.status === 'approved') {
      return res.status(400).json({ error: 'Application already approved' })
    }

    const { data: institution, error: institutionError } = await supabase
      .from('institutions')
      .insert({
        name: application.name,
        type_id: application.type_id,
        country_id: application.country_id,
        city: application.city,
        website_url: application.website,
        email: application.email,
        phone: application.phone,
        description: application.description,
        is_active: true,
      })
      .select()
      .single()

    if (institutionError) {
      console.error('Error creating institution from application:', institutionError)
      return res.status(500).json({ error: 'Failed to create institution', details: institutionError.message })
    }

    const pendingPrograms = (application.programs || []).filter((p: any) => p.status === 'pending')

    if (pendingPrograms.length > 0) {
      const { data: createdPrograms, error: programsError } = await supabase
        .from('programs')
        .insert(
          pendingPrograms.map((p: any) => ({
            institution_id: institution.id,
            category_id: p.category_id,
            name: p.name,
            description: p.description,
            duration_months: p.duration_months,
            tuition_fees: p.tuition_fees,
            currency: p.currency || 'USD',
            level: p.level,
            requirements: p.requirements,
            is_active: true,
          }))
        )
        .select()

      if (programsError) {
        console.error('Error creating programs from applications:', programsError)
        return res.status(500).json({ error: 'Institution created, but failed to create programs', details: programsError.message })
      }

      await Promise.all(
        pendingPrograms.map((p: any, index: number) =>
          supabase
            .from('program_applications')
            .update({ status: 'approved', reviewed_at: new Date().toISOString(), created_program_id: createdPrograms?.[index]?.id })
            .eq('id', p.id)
        )
      )
    }

    const { data: updatedApplication, error: updateError } = await supabase
      .from('institution_applications')
      .update({
        status: 'approved',
        admin_notes: admin_notes || null,
        reviewed_at: new Date().toISOString(),
        created_institution_id: institution.id,
      })
      .eq('id', id)
      .select()
      .single()

    if (updateError) throw updateError

    res.json({ data: updatedApplication, institution, message: 'Application approved' })
  } catch (error: any) {
    console.error('Approve application error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/admin/applications/:id/reject
router.post('/applications/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { admin_notes } = req.body

    const { data, error } = await supabase
      .from('institution_applications')
      .update({ status: 'rejected', admin_notes: admin_notes || null, reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Application not found' })

    // Programs submitted alongside a rejected institution can't stand alone.
    await supabase
      .from('program_applications')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('institution_application_id', id)
      .eq('status', 'pending')

    res.json({ data, message: 'Application rejected' })
  } catch (error: any) {
    console.error('Reject application error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/admin/applications/programs/:id/approve — approve a single program
// application against an institution that's already been approved (e.g. a
// program submitted after the institution's initial onboarding batch).
router.post('/applications/programs/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { admin_notes } = req.body

    const { data: programApplication, error: fetchError } = await supabase
      .from('program_applications')
      .select('*, institution_application:institution_applications(created_institution_id)')
      .eq('id', id)
      .single()

    if (fetchError || !programApplication) {
      return res.status(404).json({ error: 'Program application not found' })
    }

    const institutionId = (programApplication as any).institution_application?.created_institution_id

    if (!institutionId) {
      return res.status(400).json({ error: 'Institution application has not been approved yet' })
    }

    const { data: program, error: programError } = await supabase
      .from('programs')
      .insert({
        institution_id: institutionId,
        category_id: programApplication.category_id,
        name: programApplication.name,
        description: programApplication.description,
        duration_months: programApplication.duration_months,
        tuition_fees: programApplication.tuition_fees,
        currency: programApplication.currency || 'USD',
        level: programApplication.level,
        requirements: programApplication.requirements,
        is_active: true,
      })
      .select()
      .single()

    if (programError) {
      console.error('Error creating program from application:', programError)
      return res.status(500).json({ error: 'Failed to create program', details: programError.message })
    }

    const { data: updated, error: updateError } = await supabase
      .from('program_applications')
      .update({ status: 'approved', admin_notes: admin_notes || null, reviewed_at: new Date().toISOString(), created_program_id: program.id })
      .eq('id', id)
      .select()
      .single()

    if (updateError) throw updateError

    res.json({ data: updated, program, message: 'Program application approved' })
  } catch (error: any) {
    console.error('Approve program application error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/admin/applications/programs/:id/reject
router.post('/applications/programs/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { admin_notes } = req.body

    const { data, error } = await supabase
      .from('program_applications')
      .update({ status: 'rejected', admin_notes: admin_notes || null, reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Program application not found' })

    res.json({ data, message: 'Program application rejected' })
  } catch (error: any) {
    console.error('Reject program application error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/admin/reviews?status=pending — list reviews for moderation, defaults to pending
router.get('/reviews', adminMiddleware, async (req, res) => {
  try {
    const { status = 'pending' } = req.query

    const { data, error } = await supabase
      .from('reviews')
      .select('*, program:programs(name), institution:institutions(name)')
      .eq('status', status as string)
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List admin reviews error:', error)
    res.status(500).json({ error: 'Failed to fetch reviews' })
  }
})

// PATCH /api/admin/reviews/:id — set status to approved/rejected
router.patch('/reviews/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    if (status !== 'approved' && status !== 'rejected') {
      return res.status(400).json({ error: 'status must be approved or rejected' })
    }

    const { data, error } = await supabase
      .from('reviews')
      .update({ status })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Review not found' })

    res.json({ data, message: `Review ${status}` })
  } catch (error: any) {
    console.error('Update review status error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/admin/scholarships — create a scholarship
router.post('/scholarships', adminMiddleware, async (req, res) => {
  try {
    const {
      title, provider, provider_logo_url, description, eligibility, benefits,
      amount, currency, coverage_type, institution_id, country_id,
      study_levels, disciplines, target_groups, application_opens, application_deadline,
      notification_date, application_url, application_process, required_documents,
      status, is_featured, source_url,
    } = req.body

    if (!title || !provider || !application_deadline) {
      return res.status(400).json({ error: 'Missing required fields', required: ['title', 'provider', 'application_deadline'] })
    }

    const { data, error } = await supabase
      .from('scholarships')
      .insert({
        title,
        provider,
        provider_logo_url: provider_logo_url || null,
        description: description || null,
        eligibility: eligibility || null,
        benefits: benefits || null,
        amount: amount || null,
        currency: currency || 'KES',
        coverage_type: coverage_type || null,
        institution_id: institution_id || null,
        country_id: country_id || null,
        study_levels: study_levels || null,
        disciplines: disciplines || null,
        target_groups: target_groups || null,
        application_opens: application_opens || null,
        application_deadline,
        notification_date: notification_date || null,
        application_url: application_url || null,
        application_process: application_process || null,
        required_documents: required_documents || null,
        status: status || 'active',
        is_featured: is_featured ?? false,
        source_url: source_url || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating scholarship:', error)
      return res.status(500).json({ error: 'Failed to create scholarship', details: error.message })
    }

    res.status(201).json({ data, message: 'Scholarship created successfully' })
  } catch (error: any) {
    console.error('Create scholarship error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/admin/scholarships/:id — update scholarship fields
router.patch('/scholarships/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const updates = req.body

    const { data, error } = await supabase
      .from('scholarships')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116' || error.code === '22P02') {
        return res.status(404).json({ error: 'Scholarship not found' })
      }
      console.error('Error updating scholarship:', error)
      return res.status(500).json({ error: 'Failed to update scholarship', details: error.message })
    }

    res.json({ data, message: 'Scholarship updated successfully' })
  } catch (error: any) {
    console.error('Update scholarship error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
