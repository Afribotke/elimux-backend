export interface SearchIntent {
  keywords: string[]
  country: string | null
  category: string | null
  level: string | null
  maxBudget: number | null
}

export interface ExtractedProgram {
  name: string
  level: string | null
  duration_months: number | null
  tuition_fees: number | null
  currency: string | null
  description: string | null
}

export interface ExtractedScholarship {
  title: string
  provider: string
  description: string | null
  eligibility: string | null
  benefits: string | null
  amount: string | null
  currency: string | null
  coverage_type: 'full' | 'partial' | 'stipend' | 'variable' | null
  application_deadline: string | null
  application_url: string | null
  required_documents: string[]
  funding_amount: number | null
  duration: number | null
  duration_unit: 'months' | 'years' | 'one_time' | null
}

export interface AIProvider {
  extractSearchIntent(input: {
    query: string
    interests: string[]
    careerGoal: string | null
  }): Promise<SearchIntent>

  extractPrograms(pageText: string): Promise<{ programs: ExtractedProgram[]; sourceLooksLikeDirectory: boolean }>

  extractScholarships(pageText: string): Promise<{ scholarships: ExtractedScholarship[] }>
}
