import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { aiProvider } from '../lib/ai'
import { getDeviceFingerprint } from '../lib/deviceFingerprint'

const router = Router()

interface AISearchBody {
  query?: string
  interests?: string[]
  careerGoal?: string | null
  countryId?: string | null
  categoryId?: string | null
  level?: string | null
  maxBudget?: number | null
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

    const intent = await aiProvider.extractSearchIntent({ query, interests, careerGoal })

    const countryResolution = await resolveCountryId(intent.country, body.countryId)
    const categoryResolution = await resolveCategoryId(intent.category, body.categoryId)
    const countryId = countryResolution.id
    const categoryId = categoryResolution.id
    const level = body.level || intent.level
    const maxBudget = body.maxBudget ?? intent.maxBudget
    const keywords = intent.keywords.length > 0 ? intent.keywords : query.split(/\s+/).filter(Boolean)

    const PROGRAM_SELECT =
      '*, institution:institutions!inner(id, name, city, country:countries(name, flag_emoji)), category:program_categories(id, name, color, icon)'

    let programsQuery = supabase.from('programs').select(PROGRAM_SELECT, { count: 'exact' }).eq('is_active', true)

    if (categoryId) programsQuery = programsQuery.eq('category_id', categoryId)
    if (countryId) programsQuery = programsQuery.eq('institution.country_id', countryId)
    if (level) programsQuery = programsQuery.eq('level', level)
    if (maxBudget != null) programsQuery = programsQuery.lte('tuition_fees', maxBudget)

    const { data: programsData, count: totalPrograms, error: programsError } = await programsQuery.limit(50)
    if (programsError) throw programsError

    let institutionsQuery = supabase
      .from('institutions')
      .select('*, type:institution_types(name, icon), country:countries(name, flag_emoji)', { count: 'exact' })
      .eq('is_active', true)

    if (countryId) institutionsQuery = institutionsQuery.eq('country_id', countryId)

    const { data: institutionsData, count: totalInstitutions, error: institutionsError } = await institutionsQuery.limit(50)
    if (institutionsError) throw institutionsError

    const rankedPrograms = (programsData || [])
      .map((p: any) => {
        const { score, reasons } = scoreProgram(p, keywords, level, maxBudget, countryResolution.name, categoryResolution.name)
        return { ...p, relevance_score: score, match_reasons: reasons }
      })
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 12)

    const rankedInstitutionsRanked = (institutionsData || [])
      .map((i: any) => ({ ...i, _score: scoreInstitution(i, keywords) }))
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
