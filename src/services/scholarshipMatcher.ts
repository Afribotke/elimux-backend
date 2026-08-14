import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface StudentProfile {
  gpa?: number
  course_field?: string
  study_level?: string
  county?: string
  country_code?: string
  gender?: string
  age?: number
  financial_need?: boolean
  orphan_status?: boolean
  disability?: boolean
  work_experience_years?: number
  career_goals?: string
  extracurriculars?: string[]
  languages?: string[]
}

export interface MatchResult {
  scholarship_id: string
  title: string
  provider: string
  amount: string | null
  application_deadline: string | null
  application_url: string | null
  source_url: string | null
  match_score: number
  matched_criteria: string[]
  missing_criteria: string[]
  is_eligible: boolean
}

export async function matchScholarships(student: StudentProfile, limit: number = 20): Promise<MatchResult[]> {
  const { data: scholarships, error } = await supabase
    .from('scholarships')
    .select('*, eligibility:scholarship_eligibility(*)')
    .eq('status', 'active')
    .eq('application_status', 'open')
    .order('is_featured', { ascending: false })
    .limit(200)

  if (error || !scholarships) throw error || new Error('Failed to fetch scholarships')

  const results: MatchResult[] = []

  for (const s of scholarships) {
    const criteria = s.eligibility || []
    let score = 0
    const matched: string[] = []
    const missing: string[] = []
    let hardFail = false

    for (const c of criteria) {
      const check = checkCriterion(student, c.criteria_type, c.criteria_value)

      if (c.is_required && !check.pass) {
        hardFail = true
        missing.push(`${c.criteria_type}: ${c.criteria_value}`)
      } else if (check.pass) {
        score += check.weight
        matched.push(c.criteria_type)
      } else {
        missing.push(`${c.criteria_type}: ${c.criteria_value} (optional)`)
      }
    }

    if (hardFail) continue

    const maxScore = criteria.filter((c: any) => c.is_required).length * 30 + criteria.filter((c: any) => !c.is_required).length * 15
    const normalizedScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 50

    results.push({
      scholarship_id: s.id,
      title: s.title,
      provider: s.provider,
      amount: s.amount,
      application_deadline: s.application_deadline,
      application_url: s.application_url,
      source_url: s.source_url,
      match_score: Math.min(normalizedScore, 100),
      matched_criteria: matched,
      missing_criteria: missing,
      is_eligible: true,
    })
  }

  results.sort((a, b) => {
    if (b.match_score !== a.match_score) return b.match_score - a.match_score
    const da = a.application_deadline ? new Date(a.application_deadline).getTime() : Infinity
    const db = b.application_deadline ? new Date(b.application_deadline).getTime() : Infinity
    return da - db
  })

  return results.slice(0, limit)
}

function checkCriterion(student: StudentProfile, type: string, value: string): { pass: boolean; weight: number } {
  switch (type) {
    case 'min_gpa':
      return { pass: (student.gpa ?? 0) >= parseFloat(value), weight: 30 }

    case 'max_gpa':
      return { pass: (student.gpa ?? 5) <= parseFloat(value), weight: 20 }

    case 'course_field':
      return {
        pass: !!student.course_field && student.course_field.toLowerCase().includes(value.toLowerCase()),
        weight: 25,
      }

    case 'country':
      return {
        pass: (student.country_code || 'KE').toLowerCase() === value.toLowerCase(),
        weight: 20,
      }

    case 'county':
      return {
        pass: !!student.county && student.county.toLowerCase() === value.toLowerCase(),
        weight: 15,
      }

    case 'gender':
      return {
        pass: !student.gender || student.gender.toLowerCase() === value.toLowerCase(),
        weight: 10,
      }

    case 'financial_need':
      return { pass: student.financial_need === true, weight: 15 }

    case 'age_min':
      return { pass: (student.age ?? 100) >= parseInt(value), weight: 10 }

    case 'age_max':
      return { pass: (student.age ?? 0) <= parseInt(value), weight: 10 }

    case 'work_experience_years':
      return { pass: (student.work_experience_years ?? 0) >= parseInt(value), weight: 10 }

    case 'career_goal':
      return {
        pass: !!student.career_goals && student.career_goals.toLowerCase().includes(value.toLowerCase()),
        weight: 15,
      }

    case 'extracurricular':
      return {
        pass: !!student.extracurriculars && student.extracurriculars.some(e => e.toLowerCase().includes(value.toLowerCase())),
        weight: 10,
      }

    case 'language_proficiency':
      return {
        pass: !!student.languages && student.languages.some(l => l.toLowerCase().includes(value.toLowerCase())),
        weight: 10,
      }

    case 'disability':
      return { pass: student.disability === true, weight: 10 }

    case 'orphan_status':
      return { pass: student.orphan_status === true, weight: 10 }

    default:
      return { pass: false, weight: 0 }
  }
}
