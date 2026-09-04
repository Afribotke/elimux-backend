import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { aiProvider } from '../lib/ai'
import type { SearchIntent } from '../lib/ai'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'
import { extractLocationFromQuery, isLocationTerm } from '../lib/locationExtractor'

const router = Router()

// In-memory cache for extracted search intents. TTL keeps common repeated
// queries (e.g. "medicine in Kenya") from paying a full Claude round-trip
// every time, without serving stale intents indefinitely. Keyed on
// interests too, not just query+careerGoal - interests are part of the
// context sent to the model (see anthropic.ts's contextLines), so two
// requests differing only in selected interests aren't the same call.
const searchIntentCache = new Map<string, { intent: SearchIntent; expires: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

function getCacheKey(query: string, interests: string[], careerGoal: string | null): string {
  const normalizedInterests = [...interests].map((i) => i.trim().toLowerCase()).sort().join(',')
  return `${query.trim().toLowerCase()}::${normalizedInterests}::${(careerGoal || '').trim().toLowerCase()}`
}

function getCachedIntent(key: string): SearchIntent | null {
  const entry = searchIntentCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    searchIntentCache.delete(key)
    return null
  }
  return entry.intent
}

function setCachedIntent(key: string, intent: SearchIntent): void {
  searchIntentCache.set(key, { intent, expires: Date.now() + CACHE_TTL_MS })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

interface AISearchBody {
  query?: string
  interests?: string[]
  careerGoal?: string | null
  countryId?: string | null
  categoryId?: string | null
  level?: string | null
  maxBudget?: number | null
  // Optional search-mode filter ('academic' | 'skills'). Omitted/null = no filter,
  // so all existing callers behave exactly as before.
  institutionMode?: 'academic' | 'skills' | null
  // Set by the "Search all of Kenya" clear-location button so a query whose text
  // still contains a location word (the user hasn't retyped it) doesn't just
  // re-detect the same location and put the filter right back.
  ignoreLocation?: boolean
}

// The LLM returns natural phrasing ("USA", "UK") or a subject synonym ("Computer
// Science") that often isn't a literal substring of our seeded name - these maps
// and the tiered lookups below exist so those common cases still resolve instead
// of silently dropping the filter.
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'United States',
  us: 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  america: 'United States',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  britain: 'United Kingdom',
  'great britain': 'United Kingdom',
  uae: 'United Arab Emirates',
}

const CATEGORY_SYNONYMS: Record<string, string> = {
  'computer science': 'Information Technology',
  cs: 'Information Technology',
  medicine: 'Medicine & Health Sciences',
  business: 'Business & Management',
  engineering: 'Engineering & Technology',
  law: 'Law & Legal Studies',
  hospitality: 'Hospitality & Tourism',
  agriculture: 'Agriculture & Environment',
  media: 'Media & Communication',
  trades: 'Trades & Vocational',
  sports: 'Sports & Fitness',
  'data science': 'Data & Analytics',
  finance: 'Finance & Accounting',
  nursing: 'Nursing & Caregiving',
  'public policy': 'Public Policy & Governance',
  science: 'Science & Mathematics',
  'social science': 'Social Sciences',
  education: 'Education & Teaching',
  architecture: 'Architecture & Design',
  aviation: 'Aviation & Maritime',
  design: 'Architecture & Design',
  'graphic design': 'Architecture & Design',
}

// Search-mode mapping against the LIVE institution_types seed values (verified
// against the production DB). Types not listed in either mode (e.g. Language
// School, Online Institution, Research Institute) only appear when no mode is
// selected - to reclassify a type, edit these lists, never the seed data.
const INSTITUTION_MODE_TYPES: Record<'academic' | 'skills', string[]> = {
  academic: ['University', 'College', 'Community College'],
  skills: ['TVET Institute', 'Polytechnic', 'Vocational School', 'Institute of Technology'],
}

async function resolveInstitutionTypeIds(mode: 'academic' | 'skills'): Promise<string[]> {
  const { data, error } = await supabase
    .from('institution_types')
    .select('id, name')
    .in('name', INSTITUTION_MODE_TYPES[mode])
    .eq('is_active', true)
  if (error) throw error
  return (data || []).map((t: any) => t.id)
}

interface ResolveResult {
  id: string | null
  // Canonical seeded name for the resolved row - used to build match_reasons and CTA copy.
  name: string | null
  // Best-effort "did you mean" name when no tier matched confidently enough to filter on.
  suggestion: string | null
}

async function resolveCountryId(name: string | null, explicitId: string | null | undefined): Promise<ResolveResult> {
  if (explicitId) {
    const { data } = await supabase.from('countries').select('name').eq('id', explicitId).maybeSingle()
    return { id: explicitId, name: data?.name ?? null, suggestion: null }
  }
  if (!name) return { id: null, name: null, suggestion: null }

  const trimmed = name.trim()
  const key = trimmed.toLowerCase()

  const { data: byName } = await supabase.from('countries').select('id,name').ilike('name', `%${trimmed}%`).limit(1).maybeSingle()
  if (byName) return { id: byName.id, name: byName.name, suggestion: null }

  const { data: byCode } = await supabase.from('countries').select('id,name').ilike('iso_code', trimmed).limit(1).maybeSingle()
  if (byCode) return { id: byCode.id, name: byCode.name, suggestion: null }

  const alias = COUNTRY_ALIASES[key]
  if (alias) {
    const { data: byAlias } = await supabase.from('countries').select('id,name').ilike('name', `%${alias}%`).limit(1).maybeSingle()
    if (byAlias) return { id: byAlias.id, name: byAlias.name, suggestion: null }
  }

  const firstWord = trimmed.split(/\s+/)[0]
  if (firstWord && firstWord.length >= 3) {
    const { data: candidate } = await supabase.from('countries').select('name').ilike('name', `%${firstWord}%`).limit(1).maybeSingle()
    if (candidate) return { id: null, name: null, suggestion: candidate.name }
  }

  return { id: null, name: null, suggestion: null }
}

async function resolveCategoryId(name: string | null, explicitId: string | null | undefined): Promise<ResolveResult> {
  if (explicitId) {
    const { data } = await supabase.from('program_categories').select('name').eq('id', explicitId).maybeSingle()
    return { id: explicitId, name: data?.name ?? null, suggestion: null }
  }
  if (!name) return { id: null, name: null, suggestion: null }

  const trimmed = name.trim()
  const key = trimmed.toLowerCase()

  const { data: byName } = await supabase.from('program_categories').select('id,name').ilike('name', `%${trimmed}%`).limit(1).maybeSingle()
  if (byName) return { id: byName.id, name: byName.name, suggestion: null }

  const { data: byDescription } = await supabase
    .from('program_categories')
    .select('id,name')
    .ilike('description', `%${trimmed}%`)
    .limit(1)
    .maybeSingle()
  if (byDescription) return { id: byDescription.id, name: byDescription.name, suggestion: null }

  const synonym = CATEGORY_SYNONYMS[key]
  if (synonym) {
    const { data: bySynonym } = await supabase.from('program_categories').select('id,name').ilike('name', `%${synonym}%`).limit(1).maybeSingle()
    if (bySynonym) return { id: bySynonym.id, name: bySynonym.name, suggestion: null }
  }

  const firstWord = trimmed.split(/\s+/)[0]
  if (firstWord && firstWord.length >= 3) {
    const { data: candidate } = await supabase.from('program_categories').select('name').ilike('name', `%${firstWord}%`).limit(1).maybeSingle()
    if (candidate) return { id: null, name: null, suggestion: candidate.name }
  }

  return { id: null, name: null, suggestion: null }
}

interface ScoreResult {
  score: number
  reasons: string[]
}

function scoreProgram(
  program: any,
  keywords: string[],
  level: string | null,
  maxBudget: number | null,
  countryName: string | null,
  categoryName: string | null
): ScoreResult {
  let score = 0
  const reasons: string[] = []
  const name = (program.name ?? '').toLowerCase()
  const haystack = `${program.name ?? ''} ${program.description ?? ''}`.toLowerCase()

  for (const kw of keywords) {
    const k = kw.toLowerCase()
    if (!k) continue
    if (name.includes(k)) {
      score += 3
      reasons.push(`Matches "${kw}" in the program name`)
    } else if (haystack.includes(k)) {
      score += 1
      reasons.push(`Matches "${kw}"`)
    }
  }

  if (level && program.level?.toLowerCase() === level.toLowerCase()) {
    score += 2
    reasons.push(`Matches your preferred level (${level})`)
  }

  if (maxBudget != null && program.tuition_fees != null && program.tuition_fees <= maxBudget) {
    score += 2
    reasons.push(`Within your budget (${program.currency ?? ''} ${program.tuition_fees})`.replace('  ', ' '))
  }

  // These aren't keyword matches - every returned program already satisfies the applied
  // filter, so they're stated as facts about why the row is in the result set at all.
  if (countryName) reasons.push(`Offered in ${countryName}`)
  if (categoryName) reasons.push(`In the ${categoryName} category`)

  return { score, reasons }
}

function scoreInstitution(institution: any, keywords: string[]): number {
  let score = 0
  const haystack = `${institution.name ?? ''} ${institution.description ?? ''}`.toLowerCase()

  for (const kw of keywords) {
    const k = kw.toLowerCase()
    if (!k) continue
    if (institution.name?.toLowerCase().includes(k)) score += 3
    else if (haystack.includes(k)) score += 1
  }

  return score
}

// AI-powered natural language search
router.post('/', async (req, res) => {
  try {
    const body: AISearchBody = req.body || {}
    const query = body.query?.trim() || ''
    const interests = body.interests ?? []
    const careerGoal = body.careerGoal ?? null

    // Runs independently of the (possibly cached) LLM intent call below - doesn't
    // depend on its output, so it goes in the same Promise.all rather than after it.
    const locationPromise = body.ignoreLocation ? Promise.resolve(null) : extractLocationFromQuery(query)

    const cacheKey = getCacheKey(query, interests, careerGoal)
    let intent = getCachedIntent(cacheKey)
    const [, location] = await Promise.all([
      (async () => {
        if (!intent) {
          intent = await withTimeout(
            aiProvider.extractSearchIntent({ query, interests, careerGoal }),
            15000,
            'AI intent extraction'
          )
          setCachedIntent(cacheKey, intent)
        }
      })(),
      locationPromise,
    ])

    if (!intent) throw new Error('Intent extraction failed unexpectedly')

    const [countryResolution, categoryResolution] = await Promise.all([
      resolveCountryId(intent.country, body.countryId),
      resolveCategoryId(intent.category, body.categoryId),
    ])
    const countryId = countryResolution.id
    const categoryId = categoryResolution.id
    const level = body.level || intent.level
    const maxBudget = body.maxBudget ?? intent.maxBudget
    // Drop any bare location words (e.g. "Nairobi") that leaked into the LLM's
    // keyword list - they're handled by the county filter below instead, and
    // left in here they'd get ilike'd against program name/description for no
    // useful match.
    const rawKeywords = intent.keywords.length > 0 ? intent.keywords : query.split(/\s+/).filter(Boolean)
    const keywords = rawKeywords.filter((k) => !isLocationTerm(k, location))
    const hasKeywordSignal = keywords.length > 0

    // Optional institution-mode filter. Anything other than 'academic'/'skills'
    // is treated as absent (no filter), keeping older clients unaffected.
    const institutionMode =
      body.institutionMode === 'academic' || body.institutionMode === 'skills' ? body.institutionMode : null
    let modeTypeIds: string[] = []
    if (institutionMode) {
      modeTypeIds = await resolveInstitutionTypeIds(institutionMode)
      if (modeTypeIds.length === 0) {
        // Fail open with a loud log: an empty mapping would otherwise silently
        // return zero results, which looks like broken search to the user.
        console.error(
          `institutionMode "${institutionMode}" matched 0 institution_types rows - check INSTITUTION_MODE_TYPES against the live seed`
        )
      }
    }

    const PROGRAM_SELECT =
      '*, institution:institutions!inner(id, name, city, country:countries(name, flag_emoji)), category:program_categories(id, name, color, icon)'

    let programsQuery = supabase.from('programs').select(PROGRAM_SELECT, { count: 'exact' }).eq('is_active', true)

    if (categoryId) programsQuery = programsQuery.eq('category_id', categoryId)
    if (countryId) programsQuery = programsQuery.eq('institution.country_id', countryId)
    if (level) programsQuery = programsQuery.eq('level', level)
    if (maxBudget != null) programsQuery = programsQuery.lte('tuition_fees', maxBudget)
    if (modeTypeIds.length > 0) programsQuery = programsQuery.in('institution.type_id', modeTypeIds)
    // Kenya county filter. `programs.county` is backfilled from institutions.city
    // (county-level only for Kenyan rows) - there's no town-level data to filter
    // on, so a town/constituency alias still narrows to its county, never further.
    if (location?.county) programsQuery = programsQuery.ilike('county', location.county)

    // When the query has a subject (keywords) but it didn't resolve to a categoryId (e.g.
    // "criminology" isn't a seeded category or synonym), category/country/level/budget alone
    // don't narrow by subject at all - a country-only filter can leave thousands of candidates,
    // and since this query has no ORDER BY, .limit(50) below grabs an arbitrary 50 of them.
    // Verified against production data: for "criminology in kenya" the 12 real criminology
    // programs in Kenya never made it into that arbitrary 50-row slice, so scoring never saw
    // them and the old code fell back to whatever unrelated programs happened to be in it.
    // Narrowing by keyword at the SQL level here (name/description ilike) fixes that - the
    // post-fetch relevance_score filter below still applies as a second pass.
    if (hasKeywordSignal && !categoryId) {
      // keywords can be raw user query words (the query.split(/\s+/) fallback above), not just
      // LLM-extracted terms - strip characters that are syntactically significant in a
      // PostgREST filter string (`,` separates OR conditions, `()` can group them) before they
      // go into a hand-built .or() string, so user input can't break or alter the filter.
      const keywordOr = keywords
        .map((k) => k.replace(/[,()]/g, '').trim())
        .filter(Boolean)
        .flatMap((k) => [`name.ilike.%${k}%`, `description.ilike.%${k}%`])
        .join(',')
      if (keywordOr) programsQuery = programsQuery.or(keywordOr)
    }

    let institutionsQuery = supabase
      .from('institutions')
      .select('*, type:institution_types(name, icon), country:countries(name, flag_emoji)', { count: 'exact' })
      .eq('is_active', true)

    if (countryId) institutionsQuery = institutionsQuery.eq('country_id', countryId)
    if (modeTypeIds.length > 0) institutionsQuery = institutionsQuery.in('type_id', modeTypeIds)
    // institutions.city doubles as the county name for Kenyan rows (verified live -
    // Nairobi=414, Kiambu=139, etc.) - no dedicated county column exists on this table.
    if (location?.county) institutionsQuery = institutionsQuery.ilike('city', location.county)

    // Independent queries - built up above without executing (Supabase query
    // builders don't hit the network until awaited), then run concurrently
    // rather than one after another.
    const [
      { data: programsData, count: totalPrograms, error: programsError },
      { data: institutionsData, count: totalInstitutions, error: institutionsError },
    ] = await Promise.all([programsQuery.limit(50), institutionsQuery.limit(50)])
    if (programsError) throw programsError
    if (institutionsError) throw institutionsError

    // scoreProgram/scoreInstitution only drive ranking, not filtering - even with the SQL-level
    // keyword narrowing above, an OR-across-keywords match doesn't guarantee every candidate is
    // actually relevant (multi-keyword queries), so still drop zero-score rows as a second pass
    // whenever there's a keyword signal to score against. Pure filter-only browsing (empty
    // keywords) is untouched - score is 0 for everyone there by design.
    const rankedPrograms = (programsData || [])
      .map((p: any) => {
        const { score, reasons } = scoreProgram(p, keywords, level, maxBudget, countryResolution.name, categoryResolution.name)
        return { ...p, relevance_score: score, match_reasons: reasons }
      })
      .filter((p: any) => !hasKeywordSignal || p.relevance_score > 0)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 12)

    const rankedInstitutionsRanked = (institutionsData || [])
      .map((i: any) => ({ ...i, _score: scoreInstitution(i, keywords) }))
      .filter((i: any) => !hasKeywordSignal || i._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6)

    // programs_count is each institution's total active-program count (not scoped to this
    // search's filters) - it answers "how much does this place offer overall", so a small
    // extra count query per ranked institution is worth the round trip.
    const rankedInstitutions = await Promise.all(
      rankedInstitutionsRanked.map(async ({ _score, ...inst }: any) => {
        const { count } = await supabase
          .from('programs')
          .select('id', { count: 'exact', head: true })
          .eq('institution_id', inst.id)
          .eq('is_active', true)
        return { ...inst, programs_count: count ?? 0 }
      })
    )

    // Related programs: when a filter has narrowed things down (or to zero), relax the
    // dimension most likely to have excluded good matches - category first (so "medicine
    // in Kenya" surfaces medicine elsewhere), else country - so there's still something
    // adjacent to explore instead of an empty results page.
    let relatedPrograms: any[] = []
    const excludeIds = rankedPrograms.map((p: any) => p.id)

    if (categoryId) {
      let relatedQuery = supabase
        .from('programs')
        .select('id, name, institution:institutions(name), category:program_categories(name)')
        .eq('is_active', true)
        .eq('category_id', categoryId)
      if (excludeIds.length > 0) relatedQuery = relatedQuery.not('id', 'in', `(${excludeIds.join(',')})`)
      const { data } = await relatedQuery.limit(4)
      relatedPrograms = (data || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        institution: { name: p.institution?.name ?? null },
        category: { name: p.category?.name ?? null },
        reason: countryResolution.name ? `Same category, outside ${countryResolution.name}` : 'Similar to your search',
      }))
    } else if (countryId) {
      let relatedQuery = supabase
        .from('programs')
        .select('id, name, institution:institutions!inner(name, country_id), category:program_categories(name)')
        .eq('is_active', true)
        .eq('institution.country_id', countryId)
      if (excludeIds.length > 0) relatedQuery = relatedQuery.not('id', 'in', `(${excludeIds.join(',')})`)
      const { data } = await relatedQuery.limit(4)
      relatedPrograms = (data || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        institution: { name: p.institution?.name ?? null },
        category: { name: p.category?.name ?? null },
        reason: `Also available in ${countryResolution.name}`,
      }))
    }

    const topProgram = rankedPrograms[0]
    const resultCount = rankedPrograms.length + rankedInstitutions.length

    // Fire-and-forget: powers GET /api/admin/analytics/searches (popular terms,
    // zero-result searches, trend) - never let tracking failure affect the response.
    if (query) {
      ;(async () => {
        try {
          await supabase.from('analytics_events').insert({
            event_type: 'search',
            user_device_id: getDeviceFingerprint(req),
            metadata: { query, result_count: resultCount, source: 'ai-search' },
          })
        } catch (err) {
          console.error('Failed to track search event:', err)
        }
      })()
    }

    res.json({
      success: true,
      data: {
        intent,
        location_detected: location,
        suggestions: {
          country: countryResolution.suggestion,
          category: categoryResolution.suggestion,
        },
        meta: {
          totalPrograms: totalPrograms ?? rankedPrograms.length,
          totalInstitutions: totalInstitutions ?? rankedInstitutions.length,
          filtersApplied: {
            country: !!countryId,
            category: !!categoryId,
            level: !!level,
            budget: maxBudget != null,
            mode: institutionMode,
          },
        },
        programs: rankedPrograms,
        institutions: rankedInstitutions,
        related_programs: relatedPrograms,
        ctas: {
          primary: countryResolution.name ? `Browse all programs in ${countryResolution.name}` : 'Browse all programs',
          secondary: categoryResolution.name ? `Compare ${categoryResolution.name} programs` : 'Explore all categories',
          links: {
            all_programs: countryId ? `/programs?country=${countryId}` : '/programs',
            category_programs: categoryId ? `/programs?category=${categoryId}` : '/programs',
            institution: topProgram?.institution?.id ? `/institutions/${topProgram.institution.id}` : null,
          },
        },
      },
    })
  } catch (error: any) {
    console.error('AI search failed:', error)
    res.status(500).json({ success: false, error: 'Search failed. Please try again.' })
  }
})

export default router
