import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { AIProvider, SearchIntent, ExtractedProgram } from '../types'

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

const ExtractedProgramSchema = z.object({
  name: z.string(),
  level: z.string().nullable(),
  duration_months: z.number().nullable(),
  tuition_fees: z.number().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
})

const ExtractedProgramsSchema = z.object({
  programs: z.array(ExtractedProgramSchema),
})

const EXTRACT_PROGRAMS_SYSTEM_PROMPT = `You extract education program listings (degrees, diplomas, certificates, courses) from a scraped institution web page's text content.

- name: the program's title, as written (e.g. "BSc Computer Science", "Diploma in Nursing")
- level: one of "Certificate", "Diploma", "Bachelor's", "Master's", "PhD", "Short Course" if determinable, else null
- duration_months: program length in months if stated (convert years to months), else null
- tuition_fees: a single numeric tuition figure if stated (the listed/base fee, not a range - use the lower bound of a range), else null
- currency: the ISO-ish currency code or symbol context implies (e.g. "KES", "USD"), else null
- description: a short 1-2 sentence description if the page provides one, else null

Only extract programs actually described on the page - do not invent programs, and do not extract unrelated content (news items, staff bios, generic marketing copy) as if it were a program. If the page lists no identifiable programs, return an empty array.`

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

  async extractPrograms(pageText: string): Promise<ExtractedProgram[]> {
    // Truncate rather than reject - a long page is still worth scraping, we
    // just don't need every byte (nav/footer boilerplate repeated across a
    // site isn't where program listings live). 4096 tokens, then 16384, both
    // confirmed too tight with live tests against uonbi.ac.ke - a large
    // public university's full catalog needs more room than either, so this
    // also retries once with a smaller input if the model's output still
    // doesn't fit at 40k chars in, rather than fail the whole scrape outright
    // over a page that's just unusually large.
    for (const inputChars of [40_000, 15_000]) {
      try {
        const response = await client.messages.parse({
          model: 'claude-opus-4-8',
          max_tokens: 32_000,
          thinking: { type: 'disabled' },
          system: EXTRACT_PROGRAMS_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: pageText.slice(0, inputChars) }],
          output_config: {
            format: zodOutputFormat(ExtractedProgramsSchema),
          },
        })

        return response.parsed_output?.programs ?? []
      } catch (err: any) {
        const isTruncatedJson = /Unterminated string|Expected .* after|Failed to parse structured output/i.test(err?.message || '')
        if (!isTruncatedJson || inputChars === 15_000) throw err
        // else: output still didn't fit - loop to the smaller input size
      }
    }

    return []
  },
}
