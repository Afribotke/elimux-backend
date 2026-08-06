import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'
import { runTvetaScrape, checkRobotsTxt } from '../services/tvetaScraper'

const router = Router()
router.use(adminMiddleware) // every /api/tveta/* route is admin-only

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

    let inserted = 0
    let duplicates = 0

    for (const inst of result.institutions) {
      if (inst.registrationNumber) {
        const { data: existing } = await supabase
          .from('tveta_scraped_institutions')
          .select('id')
          .eq('registration_number', inst.registrationNumber)
          .maybeSingle()

        if (existing) {
          duplicates++
          continue
        }
      }

      const { error } = await supabase.from('tveta_scraped_institutions').insert({
        name: inst.name,
        registration_number: inst.registrationNumber,
        category: inst.category,
        institution_type: inst.type,
        county: inst.county,
        status: inst.status,
        source_url: inst.sourceUrl,
        raw_text_snippet: inst.rawText,
        review_status: 'pending',
      })

      if (!error) inserted++
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
          tveta_registration_number: scraped.registration_number,
          tveta_accredited: true,
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
