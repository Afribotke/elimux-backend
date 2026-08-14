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

// Single source of truth for criterion weights — shared by the scorer and
// checkCriterion. Default is 0, not a nonzero fallback: an unrecognized
// criteria_type (bad data / typo) must never inflate requiredMax/optionalMax
// with a criterion that can never pass, which would silently deflate the
// score for everyone on that scholarship.
function getCriterionWeight(type: string): number {
  switch (type) {
    case 'min_gpa': return 30
    case 'max_gpa': return 20
    case 'course_field': return 25
    case 'country': return 20
    case 'county': return 15
    case 'gender': return 10
    case 'financial_need': return 15
    case 'age_min': return 10
    case 'age_max': return 10
    case 'work_experience_years': return 10
    case 'career_goal': return 15
    case 'extracurricular': return 10
    case 'language_proficiency': return 10
    case 'disability': return 10
    case 'orphan_status': return 10
    case 'study_level': return 20
    default: return 0
  }
}

/**
 * Scoring formula (required/optional 70-30 split):
 *
 * 1. Hard filter: any failed required criterion excludes the scholarship
 *    from results entirely.
 * 2. eligibility = matched required weight / total required weight
 *    (defaults to 1.0 when there are no required criteria)
 *    fit = matched optional weight / total optional weight
 *    (defaults to 0.0 when there are no optional criteria)
 * 3. match_score = min(95, round(eligibility * 70 + fit * 30))
 *    Clearing every required criterion guarantees >= 70%; the remaining
 *    30% rewards optional fit. Capped at 95 to avoid implying certainty.
 * 4. Scholarships with zero eligibility rows get a neutral 50% baseline.
 *
 * Match scores indicate alignment between the student's self-reported
 * profile and the scholarship's stated criteria — they do not guarantee
 * approval, which depends on factors (competition, essay quality,
 * references) outside this data.
 */
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
    let requiredScore = 0
    let requiredMax = 0
    let optionalScore = 0
    let optionalMax = 0
    const matched: string[] = []
    const missing: string[] = []
    let hardFail = false

    for (const c of criteria) {
      const weight = getCriterionWeight(c.criteria_type)
      const check = checkCriterion(student, c.criteria_type, c.criteria_value)

      if (c.is_required) {
        requiredMax += weight
        if (check.pass) requiredScore += weight
      } else {
        optionalMax += weight
        if (check.pass) optionalScore += weight
      }

      if (check.pass) {
        matched.push(c.criteria_type)
      } else {
        missing.push(`${c.criteria_type}: ${c.criteria_value}`)
        if (c.is_required) hardFail = true
      }
    }

    if (hardFail) continue

    const eligibility = requiredMax > 0 ? requiredScore / requiredMax : 1.0
    const fit = optionalMax > 0 ? optionalScore / optionalMax : 0.0
    const normalizedScore = criteria.length === 0
      ? 50
      : Math.min(95, Math.round(eligibility * 70 + fit * 30))

    results.push({
      scholarship_id: s.id,
      title: s.title,
      provider: s.provider,
      amount: s.amount,
      application_deadline: s.application_deadline,
      application_url: s.application_url,
      source_url: s.source_url,
      match_score: normalizedScore,
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

function checkCriterion(student: StudentProfile, type: string, value: string): { pass: boolean } {
  switch (type) {
    case 'min_gpa':
      return { pass: (student.gpa ?? 0) >= parseFloat(value) }

    case 'max_gpa':
      return { pass: (student.gpa ?? 5) <= parseFloat(value) }

    case 'course_field': {
      const studentCourse = (student.course_field || '').toLowerCase()
      const criterionValue = value.toLowerCase()
      return { pass: studentCourse.includes(criterionValue) || criterionValue.includes(studentCourse) }
    }

    case 'country': {
      const studentCountry = (student.country_code || 'KE').toLowerCase()
      return { pass: studentCountry === value.toLowerCase() }
    }

    case 'county': {
      const studentCounty = (student.county || '').toLowerCase()
      return { pass: studentCounty === value.toLowerCase() }
    }

    case 'gender': {
      if (!student.gender || student.gender === 'prefer_not_to_say') return { pass: true }
      return { pass: student.gender.toLowerCase() === value.toLowerCase() }
    }

    case 'financial_need':
      return { pass: student.financial_need === true }

    case 'age_min':
      return { pass: (student.age ?? 100) >= parseInt(value) }

    case 'age_max':
      return { pass: (student.age ?? 0) <= parseInt(value) }

    case 'work_experience_years':
      return { pass: (student.work_experience_years ?? 0) >= parseInt(value) }

    case 'career_goal': {
      const goals = (student.career_goals || '').toLowerCase()
      return { pass: goals.includes(value.toLowerCase()) }
    }

    case 'extracurricular': {
      const extras = student.extracurriculars || []
      return { pass: extras.some(e => e.toLowerCase().includes(value.toLowerCase())) }
    }

    case 'language_proficiency': {
      const langs = student.languages || []
      return { pass: langs.some(l => l.toLowerCase().includes(value.toLowerCase())) }
    }

    case 'disability':
      return { pass: student.disability === true }

    case 'orphan_status':
      return { pass: student.orphan_status === true }

    case 'study_level': {
      const studentLevel = (student.study_level || '').toLowerCase()
      return { pass: studentLevel === value.toLowerCase() }
    }

    default:
      return { pass: false }
  }
}
