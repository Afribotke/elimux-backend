import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { adminMiddleware } from '../middleware/auth'
import { validateScraperUrl } from '../lib/ssrfGuard'
import { aiProvider } from '../lib/ai'
import type { ExtractedProgram } from '../lib/ai/types'

const router = Router()
router.use(adminMiddleware) // every /api/admin/scraper/* route is admin-only

// Matches each table's CHECK constraint (found by probing - not reflected in
// PostgREST's schema, same situation as queued_actions in pwa.ts).
const SOURCE_TYPES = ['api', 'website', 'rss']
const CRAWL_FREQUENCIES = ['daily', 'weekly', 'monthly']

// Deterministic gate, not just a prompt instruction - trusting the AI's own
// "was I making this up" self-report is exactly what failed in production
// (uonbi.ac.ke/programmes: a faculty directory with no real program titles,
// where the model fabricated plausible-sounding degree names from bare
// department names like "Psychiatry" despite being told not to invent
// programs). A real degree title names its level somewhere in the string;
// a department/subject name never does.
const DEGREE_TITLE_PATTERN =
  /\b(bachelor|master|doctor|phd|ph\.d|diploma|certificate|bsc|b\.sc|ba\b|b\.a\b|msc|m\.sc|ma\b|m\.a\b|llb|llm|mbchb|beng|b\.eng|meng|m\.eng|bcom|b\.com|mcom|m\.com|mba|postgraduate|undergraduate|associate degree|short course)\b/i

function looksLikeDegreeTitle(name: string): boolean {
  return DEGREE_TITLE_PATTERN.test(name)
}

// The stronger of the two checks. looksLikeDegreeTitle() only catches a bare
// department name slipping through *untouched* - it does not catch the
// actual failure mode observed in production, where the model wrapped a bare
// name into a fabricated but degree-title-*shaped* string ("Psychiatry" ->
// "Master of Medicine in Psychiatry (Mmed. Psych.)"), which still matches
// the degree-keyword regex. A fabricated title is, by construction, text
// that doesn't appear on the page it was supposedly read from - so require
// the extracted name to actually occur verbatim (case-insensitive) in the
// source text, not just look plausible.
function isVerbatimInSource(name: string, pageText: string): boolean {
  return pageText.toLowerCase().includes(name.trim().toLowerCase())
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// POST /api/admin/scraper/run - fetch a URL, extract program listings via AI,
// diff against existing programs, and file each difference as a
// program_changes row for human review (nothing here writes to `programs`
// directly - see the /approve endpoint for that).
router.post('/run', async (req, res) => {
  const { institution_id, source_url } = req.body || {}

  if (!institution_id || !source_url) {
    return res.status(400).json({ error: 'institution_id and source_url are required' })
  }

  const urlCheck = await validateScraperUrl(source_url)
  if (!urlCheck.valid) {
    return res.status(400).json({ error: 'Refusing to fetch this URL', reason: urlCheck.reason })
  }

  const { data: job, error: jobError } = await supabase
    .from('scraper_jobs')
    .insert({ institution_id, source_url, status: 'running', started_at: new Date().toISOString() })
    .select()
    .single()

  if (jobError) {
    console.error('Create scraper job error:', jobError)
    return res.status(500).json({ error: 'Failed to create scraper job', details: jobError.message })
  }

  async function failJob(message: string) {
    await supabase
      .from('scraper_jobs')
      .update({ status: 'failed', errors: [{ message }], completed_at: new Date().toISOString() })
      .eq('id', job.id)
  }

  try {
    const response = await fetch(source_url, {
      // 15s wasn't enough for a real target (uonbi.ac.ke took ~9s just for
      // the raw fetch over a good connection, and Railway's network path was
      // evidently slower still) - confirmed by a live test that hit the
      // abort, not a guess.
      signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'ElimuxScraperBot/1.0 (+https://elimux.ke)' },
    })

    if (!response.ok) {
      await failJob(`Fetch failed with status ${response.status}`)
      return res.status(502).json({ error: 'Failed to fetch source URL', status: response.status, job_id: job.id })
    }

    const html = await response.text()
    const pageText = stripHtml(html).slice(0, 100_000)

    if (!pageText) {
      await failJob('Fetched page had no extractable text content')
      return res.status(422).json({ error: 'No extractable content on this page', job_id: job.id })
    }

    const { programs: rawExtracted, sourceLooksLikeDirectory } = await aiProvider.extractPrograms(pageText)

    // Three independent signals that an entry isn't a real, actually-scraped
    // program: the model's own self-report for the page as a whole, a
    // deterministic degree-keyword check, and (the strongest of the three)
    // whether the extracted name actually occurs verbatim in the source text
    // - a fabricated title is by construction text that wasn't on the page.
    // An entry must pass both per-entry checks to be trusted; if the whole
    // page fails, refuse to file anything rather than "some good, some bad".
    const plausible = rawExtracted.filter((p) => looksLikeDegreeTitle(p.name) && isVerbatimInSource(p.name, pageText))
    const suspiciousCount = rawExtracted.length - plausible.length

    if (rawExtracted.length > 0 && (sourceLooksLikeDirectory || plausible.length === 0)) {
      const message =
        `Extraction produced ${rawExtracted.length} entr${rawExtracted.length === 1 ? 'y' : 'ies'} that ${rawExtracted.length === 1 ? "doesn't" : "don't"} look like real programs ` +
        `(no recognizable degree title, and/or not actually present verbatim on the source page) - this source URL looks like a faculty/department ` +
        `directory, not a course catalog. Filed no changes. Point the source at a page that lists actual program titles instead.`
      await failJob(message)
      return res.status(422).json({ error: 'Source does not look like a course catalog', details: message, job_id: job.id })
    }

    // Some entries passed the degree-title check, some didn't (mixed page) -
    // keep only the plausible ones rather than discard or keep everything.
    const extracted: ExtractedProgram[] = plausible

    const { data: existingPrograms, error: existingError } = await supabase
      .from('programs')
      .select('*')
      .eq('institution_id', institution_id)
      .eq('is_active', true)

    if (existingError) throw existingError

    const existingByName = new Map((existingPrograms || []).map((p) => [p.name.trim().toLowerCase(), p]))
    const extractedNames = new Set(extracted.map((p) => p.name.trim().toLowerCase()))

    const changeRows: Record<string, unknown>[] = []
    let programsCreated = 0
    const updatedProgramIds = new Set<string>()

    // New or changed programs
    for (const found of extracted) {
      const key = found.name.trim().toLowerCase()
      const existing = existingByName.get(key)

      if (!existing) {
        changeRows.push({
          institution_id,
          program_id: null,
          change_type: 'new',
          field_name: null,
          old_value: null,
          new_value: JSON.stringify(found),
          confidence_score: 0.7,
          status: 'pending',
        })
        programsCreated++
        continue
      }

      const fieldDiffs = diffProgramFields(existing, found)
      if (fieldDiffs.length > 0) updatedProgramIds.add(existing.id)
      for (const diff of fieldDiffs) {
        changeRows.push({
          institution_id,
          program_id: existing.id,
          change_type: 'updated',
          field_name: diff.field,
          old_value: diff.oldValue,
          new_value: diff.newValue,
          confidence_score: 0.9,
          status: 'pending',
        })
      }
    }

    // Existing active programs not mentioned anywhere on the page - a weaker
    // signal (the program could just live on a different page of the site),
    // so a lower confidence score than an explicit field diff.
    for (const existing of existingPrograms || []) {
      if (!extractedNames.has(existing.name.trim().toLowerCase())) {
        changeRows.push({
          institution_id,
          program_id: existing.id,
          change_type: 'deleted',
          field_name: null,
          old_value: existing.name,
          new_value: null,
          confidence_score: 0.5,
          status: 'pending',
        })
      }
    }

    if (changeRows.length > 0) {
      const { error: changesError } = await supabase.from('program_changes').insert(changeRows)
      if (changesError) throw changesError
    }

    // Non-fatal note, not a failure: some entries were plausible degree
    // titles (kept, filed as changes above) and some weren't (dropped) - a
    // mixed page, most likely one section is a real catalog and another is
    // a directory/sidebar. Recorded on an otherwise-successful job so a
    // reviewer can see the filtering happened without it blocking anything.
    const { data: updatedJob, error: updateJobError } = await supabase
      .from('scraper_jobs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        programs_found: extracted.length,
        programs_created: programsCreated,
        programs_updated: updatedProgramIds.size,
        errors:
          suspiciousCount > 0
            ? [{ message: `Filtered ${suspiciousCount} extracted entr${suspiciousCount === 1 ? 'y' : 'ies'} with no recognizable degree title - kept only entries that look like real programs.` }]
            : [],
      })
      .eq('id', job.id)
      .select()
      .single()

    if (updateJobError) throw updateJobError

    res.json({ data: { job: updatedJob, changes_filed: changeRows.length, suspicious_entries_filtered: suspiciousCount } })
  } catch (error: any) {
    console.error('Scraper run error:', error)
    await failJob(error.message || 'Unknown error')
    res.status(500).json({ error: 'Scraper run failed', details: error.message, job_id: job.id })
  }
})

interface FieldDiff {
  field: string
  oldValue: string
  newValue: string
}

// Only fields present on both sides and meaningfully different - a field the
// scrape didn't find (null) is treated as "no signal", not "delete this
// value", since page text extraction is inherently lossy.
function diffProgramFields(existing: any, found: ExtractedProgram): FieldDiff[] {
  const diffs: FieldDiff[] = []
  const checks: [string, unknown, unknown][] = [
    ['level', existing.level, found.level],
    ['duration_months', existing.duration_months, found.duration_months],
    ['tuition_fees', existing.tuition_fees, found.tuition_fees],
    ['currency', existing.currency, found.currency],
    ['description', existing.description, found.description],
  ]

  for (const [field, oldVal, newVal] of checks) {
    if (newVal === null || newVal === undefined) continue
    if (String(oldVal ?? '') === String(newVal)) continue
    diffs.push({ field, oldValue: oldVal == null ? '' : String(oldVal), newValue: String(newVal) })
  }

  return diffs
}

// GET /api/admin/scraper/jobs?institution_id=&status=&page=&limit=
router.get('/jobs', async (req, res) => {
  try {
    const { institution_id, status, page = 1, limit = 20 } = req.query

    let query = supabase
      .from('scraper_jobs')
      .select('*, institution:institutions(name)', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (institution_id) query = query.eq('institution_id', institution_id as string)
    if (status) query = query.eq('status', status as string)

    const from = (Number(page) - 1) * Number(limit)
    const to = from + Number(limit) - 1
    query = query.range(from, to)

    const { data, error, count } = await query
    if (error) throw error

    res.json({
      data: data || [],
      meta: { page: Number(page), limit: Number(limit), total: count || 0, totalPages: Math.ceil((count || 0) / Number(limit)) },
    })
  } catch (error: any) {
    console.error('List scraper jobs error:', error)
    res.status(500).json({ error: 'Failed to fetch scraper jobs' })
  }
})

// GET /api/admin/scraper/changes?status=pending&institution_id=
router.get('/changes', async (req, res) => {
  try {
    const { status = 'pending', institution_id } = req.query

    let query = supabase
      .from('program_changes')
      .select('*, institution:institutions(name), program:programs(name)')
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status as string)
    if (institution_id) query = query.eq('institution_id', institution_id as string)

    const { data, error } = await query
    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List program changes error:', error)
    res.status(500).json({ error: 'Failed to fetch program changes' })
  }
})

// POST /api/admin/scraper/changes/:id/approve - applies the change to `programs`
router.post('/changes/:id/approve', async (req, res) => {
  try {
    const { id } = req.params

    const { data: change, error: fetchError } = await supabase.from('program_changes').select('*').eq('id', id).single()
    if (fetchError || !change) return res.status(404).json({ error: 'Change not found' })
    if (change.status !== 'pending') return res.status(400).json({ error: `Change already ${change.status}` })

    if (change.change_type === 'new') {
      const extracted = JSON.parse(change.new_value) as ExtractedProgram
      const { error: createError } = await supabase.from('programs').insert({
        institution_id: change.institution_id,
        name: extracted.name,
        level: extracted.level,
        duration_months: extracted.duration_months,
        tuition_fees: extracted.tuition_fees,
        currency: extracted.currency,
        description: extracted.description,
        is_active: true,
      })
      if (createError) throw createError
    } else if (change.change_type === 'updated') {
      if (!change.program_id) return res.status(400).json({ error: 'Change has no program_id to update' })
      const numericFields = new Set(['duration_months', 'tuition_fees'])
      const value = numericFields.has(change.field_name) ? Number(change.new_value) : change.new_value
      const { error: updateError } = await supabase
        .from('programs')
        .update({ [change.field_name]: value })
        .eq('id', change.program_id)
      if (updateError) throw updateError
    } else if (change.change_type === 'deleted') {
      if (!change.program_id) return res.status(400).json({ error: 'Change has no program_id to deactivate' })
      const { error: deactivateError } = await supabase.from('programs').update({ is_active: false }).eq('id', change.program_id)
      if (deactivateError) throw deactivateError
    }

    const { data: updated, error: statusError } = await supabase
      .from('program_changes')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (statusError) throw statusError

    res.json({ data: updated, message: 'Change approved and applied' })
  } catch (error: any) {
    console.error('Approve change error:', error)
    res.status(500).json({ error: 'Failed to approve change', details: error.message })
  }
})

// POST /api/admin/scraper/changes/:id/reject
router.post('/changes/:id/reject', async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('program_changes')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single()

    if (error || !data) return res.status(404).json({ error: 'Pending change not found' })

    res.json({ data, message: 'Change rejected' })
  } catch (error: any) {
    console.error('Reject change error:', error)
    res.status(500).json({ error: 'Failed to reject change' })
  }
})

// POST /api/admin/scraper/sources
router.post('/sources', async (req, res) => {
  try {
    const { institution_id, url, source_type = 'website', crawl_frequency = 'weekly', selectors } = req.body || {}

    if (!institution_id || !url) {
      return res.status(400).json({ error: 'institution_id and url are required' })
    }
    if (!SOURCE_TYPES.includes(source_type)) {
      return res.status(400).json({ error: 'Invalid source_type', allowed: SOURCE_TYPES })
    }
    if (!CRAWL_FREQUENCIES.includes(crawl_frequency)) {
      return res.status(400).json({ error: 'Invalid crawl_frequency', allowed: CRAWL_FREQUENCIES })
    }

    const urlCheck = await validateScraperUrl(url)
    if (!urlCheck.valid) {
      return res.status(400).json({ error: 'Refusing to save this URL', reason: urlCheck.reason })
    }

    const { data, error } = await supabase
      .from('scraping_sources')
      .insert({ institution_id, url, source_type, crawl_frequency, selectors: selectors ?? null, is_active: true })
      .select('*, institution:institutions(name)')
      .single()

    if (error) throw error

    res.status(201).json({ data })
  } catch (error: any) {
    console.error('Create scraping source error:', error)
    res.status(500).json({ error: 'Failed to create scraping source', details: error.message })
  }
})

// GET /api/admin/scraper/sources?institution_id=
router.get('/sources', async (req, res) => {
  try {
    const { institution_id } = req.query

    let query = supabase
      .from('scraping_sources')
      .select('*, institution:institutions(name)')
      .order('created_at', { ascending: false })

    if (institution_id) query = query.eq('institution_id', institution_id as string)

    const { data, error } = await query
    if (error) throw error

    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List scraping sources error:', error)
    res.status(500).json({ error: 'Failed to fetch scraping sources' })
  }
})

// PATCH /api/admin/scraper/sources/:id - not in the original spec's numbered
// list, but the frontend spec asks for "edit" sources, which needs an update
// endpoint to exist.
router.patch('/sources/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { url, source_type, crawl_frequency, selectors, is_active } = req.body || {}

    const updates: Record<string, unknown> = {}
    if (url !== undefined) {
      const urlCheck = await validateScraperUrl(url)
      if (!urlCheck.valid) return res.status(400).json({ error: 'Refusing to save this URL', reason: urlCheck.reason })
      updates.url = url
    }
    if (source_type !== undefined) {
      if (!SOURCE_TYPES.includes(source_type)) return res.status(400).json({ error: 'Invalid source_type', allowed: SOURCE_TYPES })
      updates.source_type = source_type
    }
    if (crawl_frequency !== undefined) {
      if (!CRAWL_FREQUENCIES.includes(crawl_frequency)) {
        return res.status(400).json({ error: 'Invalid crawl_frequency', allowed: CRAWL_FREQUENCIES })
      }
      updates.crawl_frequency = crawl_frequency
    }
    if (selectors !== undefined) updates.selectors = selectors
    if (is_active !== undefined) updates.is_active = is_active

    const { data, error } = await supabase
      .from('scraping_sources')
      .update(updates)
      .eq('id', id)
      .select('*, institution:institutions(name)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Source not found' })

    res.json({ data, message: 'Source updated' })
  } catch (error: any) {
    console.error('Update scraping source error:', error)
    res.status(500).json({ error: 'Failed to update scraping source', details: error.message })
  }
})

// DELETE /api/admin/scraper/sources/:id - same rationale as PATCH above:
// "remove URLs" in the frontend spec needs a real delete endpoint.
router.delete('/sources/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase.from('scraping_sources').delete().eq('id', id)
    if (error) throw error

    res.json({ message: 'Source removed' })
  } catch (error: any) {
    console.error('Delete scraping source error:', error)
    res.status(500).json({ error: 'Failed to remove scraping source' })
  }
})

export default router
