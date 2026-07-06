import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { AIProvider, SearchIntent } from '../types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SearchIntentSchema = z.object({
  keywords: z.array(z.string()),
  country: z.string().nullable(),
  category: z.string().nullable(),
  level: z.string().nullable(),
  maxBudget: z.number().nullable(),
})

const SYSTEM_PROMPT = `You extract structured search intent from a student's education search query.

- keywords: individual atomic search terms - single words or short proper nouns only (e.g. "medicine", "nursing", "computer science", "engineering"). Never include filler/intent words like "study", "want", "looking for", "programs", "courses". Never include the country, category, level, or budget already captured in their own fields below.
- country: a country name if mentioned or implied (e.g. "Kenya", "South Africa"), else null
- category: a subject/field of study if mentioned (e.g. "Medicine", "Computer Science", "Business"), else null
- level: one of "Certificate", "Diploma", "Bachelor's", "Master's", "PhD" if implied, else null
- maxBudget: a maximum tuition figure in USD if a budget is mentioned or implied, else null

Only extract what is actually present or clearly implied. Do not guess.`

export const anthropicProvider: AIProvider = {
  async extractSearchIntent({ query, interests, careerGoal }): Promise<SearchIntent> {
    const contextLines = [`Query: "${query}"`]
    if (interests.length > 0) contextLines.push(`Selected interests: ${interests.join(', ')}`)
    if (careerGoal) contextLines.push(`Career goal: ${careerGoal}`)

    const response = await client.messages.parse({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contextLines.join('\n') }],
      output_config: {
        format: zodOutputFormat(SearchIntentSchema),
      },
    })

    if (!response.parsed_output) {
      return { keywords: query.split(/\s+/).filter(Boolean), country: null, category: null, level: null, maxBudget: null }
    }

    return response.parsed_output
  },
}
