import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'
import { runTvetaScrape, checkRobotsTxt } from '../services/tvetaScraper'

const router = Router()

// ── GET /api/tveta/public-search ──
// Public, unauthenticated lookup so students can check whether an
// institution is TVETA-accredited before enrolling. Registered ahead of
// adminMiddleware below so this one route is exempt from the admin gate.
router.get('/public-search', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (q.length < 3) {
      return res.status(400).json({ error: 'Query must be at least 3 characters' })
    }

    const { data, error } = await supabase
      .from('institutions')
      .select('id, name, tveta_registration_number, tveta_accredited, city, type:institution_types(name)')
      .eq('tveta_accredited', true)
      .eq('is_active', true)
      .ilike('name', `%${q}%`)
      .limit(10)

    if (error) throw error

    const results = (data || []).map((inst: any) => ({
      id: inst.id,
      name: inst.name,
      registrationNumber: inst.tveta_registration_number,
      accredited: inst.tveta_accredited,
      category: inst.type?.name || null,
      county: inst.city || null,
    }))

    return res.json({ data: results })
  } catch (err: any) {
    console.error('[tveta] public-search:', err)
    return res.status(500).json({ error: err.message })
  }
})

router.use(adminMiddleware) // every other /api/tveta/* route is admin-only

// ── POST /api/tveta/run ──
// Trigger a scrape of the TVETA accreditation registry.
router.post('/run', async (req, res) => {
  try {
    const robots = await checkRobotsTxt()
    if (!robots.allowed) {
      return res.status(403).json({ error: 'Scraping disallowed by robots.txt', rules: robots.rules })
    }

    const result = await runTvetaScrape()
    if (!result.success) {
      return res.status(400).json({ error: 'Scrape failed', details: result.errors })
    }

    console.log(`[tveta] run: scraped ${result.institutions.length} institutions, checking for duplicates`)

    // Batch the duplicate check into a handful of `IN (...)` queries instead of
    // one SELECT per institution — the per-row version was doing 1000+
    // sequential round trips and blowing past request timeouts.
    const regNumbers = result.institutions
      .map((inst) => inst.registrationNumber)
      .filter((v): v is string => !!v)

    const existingRegNumbers = new Set<string>()
    const CHECK_BATCH = 100 // keep each `.in()` list well under Postgres/URL limits
    for (let i = 0; i < regNumbers.length; i += CHECK_BATCH) {
      const chunk = regNumbers.slice(i, i + CHECK_BATCH)
      const { data: existing, error } = await supabase
        .from('tveta_scraped_institutions')
        .select('registration_number')
        .in('registration_number', chunk)

      if (error) throw error
      existing?.forEach((row) => row.registration_number && existingRegNumbers.add(row.registration_number))
    }

    const toInsert = result.institutions.filter(
      (inst) => !inst.registrationNumber || !existingRegNumbers.has(inst.registrationNumber)
    )
    const duplicates = result.institutions.length - toInsert.length

    console.log(`[tveta] run: ${toInsert.length} new, ${duplicates} duplicates — inserting in batches of 100`)

    let inserted = 0
    const INSERT_BATCH = 100
    for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
      const batchNum = i / INSERT_BATCH + 1
      const batch = toInsert.slice(i, i + INSERT_BATCH).map((inst) => ({
        name: inst.name,
        registration_number: inst.registrationNumber,
        category: inst.category,
        institution_type: inst.type,
        county: inst.county,
        status: inst.status,
        source_url: inst.sourceUrl,
        review_status: 'pending',
      }))

      const { error } = await supabase.from('tveta_scraped_institutions').insert(batch)
      if (error) {
        console.error(`[tveta] run: batch ${batchNum} failed:`, error.message)
        continue
      }

      inserted += batch.length
      console.log(`[tveta] run: batch ${batchNum} inserted (${inserted}/${toInsert.length})`)
    }

    return res.json({
      success: true,
      pagesScanned: result.pagesScanned,
      institutionsFound: result.institutions.length,
      inserted,
      duplicates,
      robotsRules: robots.rules,
    })
  } catch (err: any) {
    console.error('[tveta] run:', err)
    return res.status(500).json({ error: 'Scraper failed', message: err.message })
  }
})

// ── GET /api/tveta/status ──
router.get('/status', async (req, res) => {
  try {
    const { count: pending } = await supabase
      .from('tveta_scraped_institutions')
      .select('*', { count: 'exact', head: true })
      .eq('review_status', 'pending')

    const { count: approved } = await supabase
      .from('tveta_scraped_institutions')
      .select('*', { count: 'exact', head: true })
      .eq('review_status', 'approved')

    const { count: total } = await supabase
      .from('tveta_scraped_institutions')
      .select('*', { count: 'exact', head: true })

    return res.json({ pending: pending || 0, approved: approved || 0, total: total || 0 })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/tveta/pending ──
router.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tveta_scraped_institutions')
      .select('*')
      .eq('review_status', 'pending')
      .order('scraped_at', { ascending: false })
      .limit(200)

    if (error) throw error
    return res.json({ data: data || [] })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/tveta/approve/:id ──
// Link (or create) the matching institution and flag it TVETA-accredited.
router.post('/approve/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data: scraped, error: fetchError } = await supabase
      .from('tveta_scraped_institutions')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !scraped) {
      return res.status(404).json({ error: 'Scraped institution not found' })
    }

    // Expired licenses don't count as currently accredited — reject instead
    // of approving, so verify-college can't surface a stale claim.
    if (scraped.status === 'Expired License') {
      await supabase
        .from('tveta_scraped_institutions')
        .update({ review_status: 'rejected' })
        .eq('id', id)
      return res.status(400).json({
        error: 'Cannot approve institution with expired TVETA license',
        status: scraped.status,
      })
    }

    // TVETA's registry uses short category codes; institution_types uses
    // full descriptive names for its curated, icon-bearing list. Map known
    // codes (and their full-length variants, in case a future scrape source
    // uses them) onto existing type rows — an unmapped code leaves type_id
    // null instead of spawning a junk institution_types row.
    const CATEGORY_MAP: Record<string, string> = {
      NP: 'Polytechnic',
      'National Polytechnic': 'Polytechnic',
      TVC: 'TVET Institute',
      'Technical Vocational College': 'TVET Institute',
      VTC: 'Vocational School',
      'Vocational Training Centre': 'Vocational School',
    }

    let typeId: string | null = null
    if (scraped.category) {
      const mappedTypeName = CATEGORY_MAP[scraped.category] || scraped.category

      const { data: existingType } = await supabase
        .from('institution_types')
        .select('id')
        .ilike('name', mappedTypeName)
        .maybeSingle()

      if (existingType) typeId = existingType.id
    }

    const { data: existing } = await supabase
      .from('institutions')
      .select('id')
      .ilike('name', scraped.name)
      .maybeSingle()

    let institutionId: string

    if (existing) {
      const { data: updated, error: updateError } = await supabase
        .from('institutions')
        .update({
          tveta_registration_number: scraped.registration_number,
          tveta_accredited: true,
          tveta_status: scraped.status,
          city: scraped.county,
          ...(typeId ? { type_id: typeId } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id')
        .single()

      if (updateError || !updated) throw updateError || new Error('Update failed')
      institutionId = updated.id
    } else {
      const { data: created, error: insertError } = await supabase
        .from('institutions')
        .insert({
          name: scraped.name,
          city: scraped.county,
          country: 'Kenya',
          type_id: typeId,
          tveta_registration_number: scraped.registration_number,
          tveta_accredited: true,
          tveta_status: scraped.status,
          is_active: true,
        })
        .select('id')
        .single()

      if (insertError || !created) throw insertError || new Error('Insert failed')
      institutionId = created.id
    }

    await supabase
      .from('tveta_scraped_institutions')
      .update({ review_status: 'approved', mapped_to_institution_id: institutionId })
      .eq('id', id)

    return res.json({ success: true, institutionId, message: 'Approved and linked to institutions' })
  } catch (err: any) {
    console.error('[tveta] approve:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/tveta/bulk-approve ──
// Approve all pending institutions with Active status (skip Expired License)
router.post('/bulk-approve', adminMiddleware, async (req, res) => {
  try {
    const { data: pending, error: fetchError } = await supabase
      .from('tveta_scraped_institutions')
      .select('*')
      .eq('review_status', 'pending')

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message })
    }

    const toApprove = (pending || []).filter((inst: any) => inst.status !== 'Expired License')
    const skipped = (pending || []).filter((inst: any) => inst.status === 'Expired License')

    let approved = 0
    let errors = 0
    const BATCH_SIZE = 100

    for (let i = 0; i < toApprove.length; i += BATCH_SIZE) {
      const batch = toApprove.slice(i, i + BATCH_SIZE)

      for (const scraped of batch) {
        try {
          // Map category to type_id
          const CATEGORY_MAP: Record<string, string> = {
            NP: 'Polytechnic',
            'National Polytechnic': 'Polytechnic',
            TVC: 'TVET Institute',
            'Technical Vocational College': 'TVET Institute',
            VTC: 'Vocational School',
            'Vocational Training Centre': 'Vocational School',
          }

          const mappedTypeName = CATEGORY_MAP[scraped.category] || scraped.category
          let typeId: string | null = null

          if (mappedTypeName) {
            const { data: existingType } = await supabase
              .from('institution_types')
              .select('id')
              .ilike('name', mappedTypeName)
              .single()

            if (existingType) typeId = existingType.id
          }

          // Check if institution already exists
          const { data: existing } = await supabase
            .from('institutions')
            .select('id')
            .ilike('name', scraped.name)
            .single()

          let institutionId: string

          if (existing) {
            const { data: updated } = await supabase
              .from('institutions')
              .update({
                tveta_registration_number: scraped.registration_number,
                tveta_accredited: true,
                tveta_status: scraped.status,
                city: scraped.county,
                type_id: typeId,
                updated_at: new Date().toISOString(),
              })
              .eq('id', existing.id)
              .select()
              .single()
            institutionId = updated!.id
          } else {
            const { data: created } = await supabase
              .from('institutions')
              .insert({
                name: scraped.name,
                city: scraped.county,
                country: 'Kenya',
                tveta_registration_number: scraped.registration_number,
                tveta_accredited: true,
                tveta_status: scraped.status,
                type_id: typeId,
                is_active: true,
              })
              .select()
              .single()
            institutionId = created!.id
          }

          // Mark scraped as approved
          await supabase
            .from('tveta_scraped_institutions')
            .update({ review_status: 'approved', mapped_to_institution_id: institutionId })
            .eq('id', scraped.id)

          approved++
        } catch (err: any) {
          console.error(`[Bulk Approve Error] ${scraped.name}:`, err.message)
          errors++
        }
      }
    }

    return res.json({
      success: true,
      totalPending: pending?.length || 0,
      approved,
      skipped: skipped.length,
      errors,
    })
  } catch (err: any) {
    console.error('[Bulk Approve]', err)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/tveta/reject/:id ──
router.post('/reject/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase
      .from('tveta_scraped_institutions')
      .update({ review_status: 'rejected' })
      .eq('id', id)

    if (error) throw error
    return res.json({ success: true })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

export default router
