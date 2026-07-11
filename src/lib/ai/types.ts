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

export interface AIProvider {
  extractSearchIntent(input: {
    query: string
    interests: string[]
    careerGoal: string | null
  }): Promise<SearchIntent>

  extractPrograms(pageText: string): Promise<{ programs: ExtractedProgram[]; sourceLooksLikeDirectory: boolean }>
}
