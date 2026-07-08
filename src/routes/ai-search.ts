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

async function resolveCountryId(name: string | null, explicitId: string | null | undefined) {
  if (explicitId) return explicitId
  if (!name) return null
  const { data } = await supabase.from('countries').select('id').ilike('name', `%${name}%`).limit(1).maybeSingle()
  return data?.id ?? null
}

async function resolveCategoryId(name: string | null, explicitId: string | null | undefined) {
  if (explicitId) return explicitId
  if (!name) return null
  const { data } = await supabase.from('program_categories').select('id').ilike('name', `%${name}%`).limit(1).maybeSingle()
  return data?.id ?? null
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

    const countryId = await resolveCountryId(intent.country, body.countryId)
    const categoryId = await resolveCategoryId(intent.category, body.categoryId)
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
        programs: rankedPrograms,
        institutions: rankedInstitutions,
      },
    })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
