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
  // Self-reported, not authoritative - src/routes/scraper.ts's
  // looksLikeDegreeTitle() deterministic check is the real gate, since
  // trusting an LLM's own "was I making this up" assessment is exactly the
  // kind of thing that just failed (see EXTRACT_PROGRAMS_SYSTEM_PROMPT's
  // history: uonbi.ac.ke/programmes is a faculty directory with no actual
  // program titles, and the model fabricated plausible-sounding ones from
  // department names anyway, despite an earlier "do not invent" instruction).
  // This field is a second, independent signal, not a replacement for
  // code-level validation.
  source_looks_like_directory: z.boolean(),
})

const EXTRACT_PROGRAMS_SYSTEM_PROMPT = `You extract education program listings (degrees, diplomas, certificates, courses) from a scraped institution web page's text content.

- name: the program's title, as written (e.g. "BSc Computer Science", "Diploma in Nursing")
- level: one of "Certificate", "Diploma", "Bachelor's", "Master's", "PhD", "Short Course" if determinable, else null
- duration_months: program length in months if stated (convert years to months), else null
- tuition_fees: a single numeric tuition figure if stated (the listed/base fee, not a range - use the lower bound of a range), else null
- currency: the ISO-ish currency code or symbol context implies (e.g. "KES", "USD"), else null
- description: a short 1-2 sentence description if the page provides one, else null

Only extract programs actually described on the page - do not invent programs, and do not extract unrelated content (news items, staff bios, generic marketing copy) as if it were a program.

If the page contains only faculty/department/subject names (e.g. "School of Medicine", "Faculty of Engineering", "Psychiatry", "Human Anatomy") without specific degree programs (e.g. "Bachelor of Medicine and Bachelor of Surgery", "Master of Medicine in Psychiatry"), that is a directory or org-chart page, not a course catalog - do not synthesize plausible-sounding degree titles from those names. Return an empty programs array and set source_looks_like_directory to true. A bare subject or department name is never itself a program name.

If the page lists no identifiable programs for any other reason, return an empty array and set source_looks_like_directory to false.`

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

  async extractPrograms(pageText: string): Promise<{ programs: ExtractedProgram[]; sourceLooksLikeDirectory: boolean }> {
    // Truncate rather than reject - a long page is still worth scraping, we
    // just don't need every byte (nav/footer boilerplate repeated across a
    // site isn't where program listings live).
    //
    // Uses .stream() + .finalMessage() rather than .parse(): a large public
    // university's full catalog (confirmed live against uonbi.ac.ke) needs
    // enough output tokens that the SDK's own non-streaming path refuses to
    // run at all - client.messages.parse() is non-streaming-only and the SDK
    // throws "Streaming is required for operations that may take longer than
    // 10 minutes" once max_tokens exceeds ~21,333 (see
    // calculateNonstreamingTimeout in the SDK: throws when
    // (60min * maxTokens / 128000) > 10min). .stream() has no such ceiling
    // and still gets the same parsed_output convenience via output_config.format.
    for (const inputChars of [40_000, 15_000]) {
      try {
        const stream = client.messages.stream({
          model: 'claude-opus-4-8',
          max_tokens: 64_000,
          thinking: { type: 'disabled' },
          system: EXTRACT_PROGRAMS_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: pageText.slice(0, inputChars) }],
          output_config: {
            format: zodOutputFormat(ExtractedProgramsSchema),
          },
        })

        const message = await stream.finalMessage()
        return {
          programs: message.parsed_output?.programs ?? [],
          sourceLooksLikeDirectory: message.parsed_output?.source_looks_like_directory ?? false,
        }
      } catch (err: any) {
        const isTruncatedJson = /Unterminated string|Expected .* after|Failed to parse structured output/i.test(err?.message || '')
        if (!isTruncatedJson || inputChars === 15_000) throw err
        // else: output still didn't fit even with streaming - loop to the
        // smaller input size rather than fail the whole scrape outright.
      }
    }

    return { programs: [], sourceLooksLikeDirectory: false }
  },
}
