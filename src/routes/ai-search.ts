import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { aiProvider } from '../lib/ai'

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
}

interface ResolveResult {
  id: string | null
  // Best-effort "did you mean" name when no tier matched confidently enough to filter on.
  suggestion: string | null
}

async function resolveCountryId(name: string | null, explicitId: string | null | undefined): Promise<ResolveResult> {
  if (explicitId) return { id: explicitId, suggestion: null }
  if (!name) return { id: null, suggestion: null }

  const trimmed = name.trim()
  const key = trimmed.toLowerCase()

  const { data: byName } = await supabase.from('countries').select('id').ilike('name', `%${trimmed}%`).limit(1).maybeSingle()
  if (byName) return { id: byName.id, suggestion: null }

  const { data: byCode } = await supabase.from('countries').select('id').ilike('iso_code', trimmed).limit(1).maybeSingle()
  if (byCode) return { id: byCode.id, suggestion: null }

  const alias = COUNTRY_ALIASES[key]
  if (alias) {
    const { data: byAlias } = await supabase.from('countries').select('id').ilike('name', `%${alias}%`).limit(1).maybeSingle()
    if (byAlias) return { id: byAlias.id, suggestion: null }
  }

  const firstWord = trimmed.split(/\s+/)[0]
  if (firstWord && firstWord.length >= 3) {
    const { data: candidate } = await supabase.from('countries').select('name').ilike('name', `%${firstWord}%`).limit(1).maybeSingle()
    if (candidate) return { id: null, suggestion: candidate.name }
  }

  return { id: null, suggestion: null }
}

async function resolveCategoryId(name: string | null, explicitId: string | null | undefined): Promise<ResolveResult> {
  if (explicitId) return { id: explicitId, suggestion: null }
  if (!name) return { id: null, suggestion: null }

  const trimmed = name.trim()
  const key = trimmed.toLowerCase()

  const { data: byName } = await supabase.from('program_categories').select('id').ilike('name', `%${trimmed}%`).limit(1).maybeSingle()
  if (byName) return { id: byName.id, suggestion: null }

  const { data: byDescription } = await supabase
    .from('program_categories')
    .select('id')
    .ilike('description', `%${trimmed}%`)
    .limit(1)
    .maybeSingle()
  if (byDescription) return { id: byDescription.id, suggestion: null }

  const synonym = CATEGORY_SYNONYMS[key]
  if (synonym) {
    const { data: bySynonym } = await supabase.from('program_categories').select('id').ilike('name', `%${synonym}%`).limit(1).maybeSingle()
    if (bySynonym) return { id: bySynonym.id, suggestion: null }
  }

  const firstWord = trimmed.split(/\s+/)[0]
  if (firstWord && firstWord.length >= 3) {
    const { data: candidate } = await supabase.from('program_categories').select('name').ilike('name', `%${firstWord}%`).limit(1).maybeSingle()
    if (candidate) return { id: null, suggestion: candidate.name }
  }

  return { id: null, suggestion: null }
}

function scoreProgram(program: any, keywords: string[], level: string | null, maxBudget: number | null): number {
  let score = 0
  const haystack = `${program.name ?? ''} ${program.description ?? ''}`.toLowerCase()

  for (const kw of keywords) {
    const k = kw.toLowerCase()
    if (!k) continue
    if (program.name?.toLowerCase().includes(k)) score += 3
    else if (haystack.includes(k)) score += 1
  }

  if (level && program.level?.toLowerCase() === level.toLowerCase()) score += 2
  if (maxBudget != null && program.tuition_fees != null && program.tuition_fees <= maxBudget) score += 2

  return score
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

    let programsQuery = supabase
      .from('programs')
      .select('*, institution:institutions!inner(name, city, country:countries(name)), category:program_categories(name, color, icon)')
      .eq('is_active', true)

    if (categoryId) programsQuery = programsQuery.eq('category_id', categoryId)
    if (countryId) programsQuery = programsQuery.eq('institution.country_id', countryId)
    if (level) programsQuery = programsQuery.eq('level', level)
    if (maxBudget != null) programsQuery = programsQuery.lte('tuition_fees', maxBudget)

    const { data: programsData, error: programsError } = await programsQuery.limit(50)
    if (programsError) throw programsError

    let institutionsQuery = supabase
      .from('institutions')
      .select('*, type:institution_types(name, icon), country:countries(name, flag_emoji)')
      .eq('is_active', true)

    if (countryId) institutionsQuery = institutionsQuery.eq('country_id', countryId)

    const { data: institutionsData, error: institutionsError } = await institutionsQuery.limit(50)
    if (institutionsError) throw institutionsError

    const rankedPrograms = (programsData || [])
      .map((p) => ({ ...p, _score: scoreProgram(p, keywords, level, maxBudget) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 12)

    const rankedInstitutions = (institutionsData || [])
      .map((i) => ({ ...i, _score: scoreInstitution(i, keywords) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, 6)

    res.json({
      success: true,
      data: {
        intent,
        suggestions: {
          country: countryResolution.suggestion,
          category: categoryResolution.suggestion,
        },
        programs: rankedPrograms,
        institutions: rankedInstitutions,
      },
    })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
