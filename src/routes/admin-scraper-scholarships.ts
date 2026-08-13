import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { scrapeScholarshipPage, PHASE_2_SOURCES } from '../services/scholarshipScraper'
import { extractScholarshipsFromText } from '../services/aiScholarshipExtract'
import { validateScraperUrl } from '../lib/ssrfGuard'
import { normalizeCoverageType, parseDeadline } from '../services/scholarshipNormalizer'
import { adminMiddleware } from '../middleware/auth'

const router = Router()
router.use(adminMiddleware)

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

router.post('/scholarships/run', async (req: Request, res: Response) => {
  try {
    const { url, sourceName } = req.body
    let targetUrl = url

    if (sourceName && !url) {
      const source = PHASE_2_SOURCES.find(s => s.name === sourceName)
      if (!source) return res.status(400).json({ error: `Unknown source: ${sourceName}` })
      targetUrl = source.url
    }

    if (!targetUrl) return res.status(400).json({ error: 'URL or sourceName required' })

    const validation = await validateScraperUrl(targetUrl)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason || 'Invalid URL' })
    }

    const result = await scrapeScholarshipPage(targetUrl, extractScholarshipsFromText)

    const inserts = result.scholarships.map(s => ({
      source_url: targetUrl,
      status: 'pending',
      title: s.title,
      provider: s.provider,
      description: s.description,
      eligibility: s.eligibility,
      benefits: s.benefits,
      amount: s.amount,
      currency: s.currency,
      coverage_type: normalizeCoverageType(s.coverage_type),
      application_deadline: s.application_deadline,
      application_url: s.application_url,
      required_documents: s.required_documents,
      funding_amount: s.funding_amount,
      duration: s.duration,
      duration_unit: s.duration_unit,
      raw_text: result.rawText,
      confidence_score: result.confidenceScore,
    }))

    const { data, error } = await supabase.from('scholarship_changes').insert(inserts).select()
    if (error) throw error

    res.json({ success: true, extracted: result.scholarships.length, staged: data?.length || 0, confidence: result.confidenceScore, changes: data })
  } catch (error: any) {
    console.error('Scraper error:', error)
    res.status(500).json({ error: error.message || 'Scraper failed' })
  }
})

router.get('/scholarships/changes', async (req: Request, res: Response) => {
  try {
    const { status = 'pending', page = '1', limit = '20' } = req.query
    const from = (parseInt(page as string) - 1) * parseInt(limit as string)
    const to = from + parseInt(limit as string) - 1

    const { data, error, count } = await supabase
      .from('scholarship_changes')
      .select('*', { count: 'exact' })
      .eq('status', status as string)
      .order('scraped_at', { ascending: false })
      .range(from, to)

    if (error) throw error
    res.json({ data, meta: { page: parseInt(page as string), limit: parseInt(limit as string), total: count || 0 } })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/scholarships/changes/:id/approve', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { notes } = req.body
    const reviewedBy = (req as any).user?.id || null

    const { data: change, error: fetchError } = await supabase.from('scholarship_changes').select('*').eq('id', id).single()
    if (fetchError || !change) return res.status(404).json({ error: 'Change not found' })
    if (change.status !== 'pending') return res.status(400).json({ error: `Already ${change.status}` })

    const deadlineResult = parseDeadline(change.application_deadline)
    if (deadlineResult.error) {
      return res.status(400).json({ error: 'Cannot approve: invalid deadline', detail: deadlineResult.error, change_id: id })
    }

    const normalizedCoverage = normalizeCoverageType(change.coverage_type)
    if (change.coverage_type && !normalizedCoverage) {
      return res.status(400).json({ error: 'Cannot approve: coverage_type invalid', received: change.coverage_type, change_id: id })
    }

    const { data: sponsorMatch } = await supabase.from('scholarship_sponsors').select('id').ilike('name', `%${change.provider}%`).limit(1).single()

    const scholarshipPayload: any = {
      title: change.title,
      provider: change.provider,
      description: change.description,
      eligibility: change.eligibility,
      benefits: change.benefits,
      amount: change.amount,
      currency: change.currency || 'KES',
      coverage_type: normalizedCoverage,
      application_deadline: deadlineResult.date,
      application_url: change.application_url,
      required_documents: change.required_documents || [],
      funding_amount: change.funding_amount,
      duration: change.duration,
      duration_unit: change.duration_unit,
      status: 'active',
      application_status: 'open',
      provider_id: sponsorMatch?.id || null,
      source_url: change.source_url,
      scraped_at: change.scraped_at,
    }

    const { data: scholarship, error: insertError } = await supabase.from('scholarships').insert(scholarshipPayload).select().single()
    if (insertError) throw insertError

    await supabase.from('scholarship_changes').update({ status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(), review_notes: notes }).eq('id', id)
    res.json({ success: true, scholarship })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/scholarships/changes/:id/reject', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { notes } = req.body
    const reviewedBy = (req as any).user?.id || null

    const { error } = await supabase.from('scholarship_changes').update({ status: 'rejected', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(), review_notes: notes }).eq('id', id)
    if (error) throw error
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/scholarships/sources', (req: Request, res: Response) => {
  res.json({ data: PHASE_2_SOURCES })
})

export default router
