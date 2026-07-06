export interface SearchIntent {
  keywords: string[]
  country: string | null
  category: string | null
  level: string | null
  maxBudget: number | null
}

export interface AIProvider {
  extractSearchIntent(input: {
    query: string
    interests: string[]
    careerGoal: string | null
  }): Promise<SearchIntent>
}
