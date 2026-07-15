// Seeds synthetic (AI-generated, unverified) programs for institutions that have
// fewer than 5 real programs, so AI search has enough catalog depth while real
// program data is collected. Every row is written with is_ai_generated: true,
// is_verified: false, and the frontend renders a matching "AI-generated ·
// unverified" disclosure badge (ProgramVerificationBadge.tsx) - do not run this
// without that badge already deployed.
//
// Run via `railway run -- npx ts-node scripts/generate-synthetic-programs.ts [limit]`
// so it picks up the production SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// ANTHROPIC_API_KEY without those ever touching a local .env file.
//
// Optional [limit] caps how many institutions to process (top N by
// student_count) - use a small number for a dry run before the full ~500.
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-haiku-4-5'
// Haiku 4.5 pricing: $1.00 / $5.00 per MTok (input / output).
const COST_PER_INPUT_TOKEN = 1.0 / 1_000_000
const COST_PER_OUTPUT_TOKEN = 5.0 / 1_000_000
const COST_STOP_LIMIT_USD = 50

const TOP_N_INSTITUTIONS = 500
const BATCH_SIZE = 50
const MIN_EXISTING_PROGRAMS_TO_SKIP = 5
const MIN_PROGRAMS_PER_INSTITUTION = 20
const MAX_PROGRAMS_PER_INSTITUTION = 30

// Must match program_categories.name exactly (verified against production).
const CATEGORY_NAMES = [
  'Medicine & Health Sciences',
  'Engineering & Technology',
  'Business & Management',
  'Law & Legal Studies',
  'Education & Teaching',
  'Arts & Humanities',
  'Architecture & Design',
  'Science & Mathematics',
  'Social Sciences',
  'Information Technology',
  'Agriculture & Environment',
] as const

// Matches the dominant existing spelling in production programs.level
// ('Bachelor'/'Master' outnumber "Bachelor's"/"Master's" - see 07_/README notes).
const LEVELS = ['Bachelor', 'Master', 'PhD', 'Diploma', 'Certificate'] as const
type Level = (typeof LEVELS)[number]
const LEVEL_DISTRIBUTION: Record<Level, number> = {
  Bachelor: 0.7,
  Master: 0.2,
  PhD: 0.05,
  Diploma: 0.025,
  Certificate: 0.025,
}

type Region = 'Africa' | 'Asia' | 'Europe' | 'North America' | 'Australia' | 'South America'
const TUITION_RANGE_USD: Record<Region, [number, number]> = {
  Africa: [1000, 5000],
  Asia: [3000, 10000],
  Europe: [5000, 20000],
  'North America': [15000, 50000],
  Australia: [20000, 45000],
  'South America': [3000, 8000],
}

// ISO 3166-1 alpha-2 -> tuition-band region. Central America/Caribbean and
// Mexico are bucketed with South America (Latin American tuition levels, not
// US/Canada); Pacific island nations fall back to the Asia band. Any code not
// listed here defaults to 'Asia' rather than erroring.
const AFRICA = 'DZ AO BJ BW BF BI CM CV CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW'.split(' ')
const EUROPE = 'AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA'.split(' ')
const NORTH_AMERICA = 'CA US'.split(' ')
const AUSTRALIA = 'AU NZ'.split(' ')
const SOUTH_AMERICA = 'AR BO BR CL CO EC GY PY PE SR UY VE MX BZ CR SV GT HN NI PA CU DO HT JM BS BB TT AG DM GD KN LC VC'.split(' ')

function regionForIsoCode(isoCode: string | null | undefined): Region {
  if (isoCode) {
    if (AFRICA.includes(isoCode)) return 'Africa'
    if (EUROPE.includes(isoCode)) return 'Europe'
    if (NORTH_AMERICA.includes(isoCode)) return 'North America'
    if (AUSTRALIA.includes(isoCode)) return 'Australia'
    if (SOUTH_AMERICA.includes(isoCode)) return 'South America'
  }
  return 'Asia'
}

function slugify(name: string, institutionId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base}-${institutionId.slice(0, 8)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const SyntheticProgramSchema = z.object({
  name: z.string(),
  category: z.enum(CATEGORY_NAMES),
  level: z.enum(LEVELS),
  duration_months: z.number().int().min(3).max(72),
  tuition_fees: z.number().int().positive(),
  description: z.string(),
  requirements: z.string(),
})
const SyntheticProgramsSchema = z.object({
  programs: z.array(SyntheticProgramSchema),
})

const SYSTEM_PROMPT = `You generate realistic, plausible university program listings for a study-abroad discovery platform's placeholder catalog. These listings are explicitly flagged to end users as AI-generated and unverified - they exist to demonstrate the search experience while real program data is collected from institutions directly.

- Programs must be plausible for this specific institution's type, country, and level - not generic filler. Vary program names; never repeat the same program twice for one institution.
- Write descriptions and admission requirements in a neutral, factual tone similar to a real university catalog entry (1-2 sentences each).
- Do not invent specific real accreditation numbers, real faculty/staff names, or make legal/financial guarantees.
- Tuition must be a realistic yearly figure in USD within the given range, with postgraduate programs generally costing more than undergraduate ones.`

interface Institution {
  id: string
  name: string
  city: string | null
  student_count: number | null
  type: { name: string } | null
  country: { name: string; iso_code: string } | null
}

interface GenerationResult {
  programs: z.infer<typeof SyntheticProgramSchema>[]
  inputTokens: number
  outputTokens: number
}

async function generateProgramsForInstitution(institution: Institution, total: number): Promise<GenerationResult> {
  const counts: Record<Level, number> = { Bachelor: 0, Master: 0, PhD: 0, Diploma: 0, Certificate: 0 }
  let remaining = total
  const levelOrder: Level[] = ['Bachelor', 'Master', 'PhD', 'Diploma', 'Certificate']
  for (let i = 0; i < levelOrder.length - 1; i++) {
    const level = levelOrder[i]
    const count = Math.round(total * LEVEL_DISTRIBUTION[level])
    counts[level] = count
    remaining -= count
  }
  counts[levelOrder[levelOrder.length - 1]] = Math.max(0, remaining)

  const region = regionForIsoCode(institution.country?.iso_code)
  const [minTuition, maxTuition] = TUITION_RANGE_USD[region]

  const userMessage = [
    `Institution: ${institution.name}`,
    `Type: ${institution.type?.name ?? 'University'}`,
    `Country: ${institution.country?.name ?? 'Unknown'}`,
    institution.city ? `City: ${institution.city}` : null,
    ``,
    `Generate exactly ${total} distinct programs for this institution:`,
    `- ${counts.Bachelor} at Bachelor level`,
    `- ${counts.Master} at Master level`,
    `- ${counts.PhD} at PhD level`,
    `- ${counts.Diploma} at Diploma level`,
    `- ${counts.Certificate} at Certificate level`,
    ``,
    `Choose each program's category from exactly these names (use the exact string, verbatim): ${CATEGORY_NAMES.join(', ')}.`,
    `Weight category choices toward what fits this institution's type (e.g. a Medical School should skew toward Medicine & Health Sciences, a Business School toward Business & Management), but a general University can span most categories.`,
    ``,
    `Tuition must be a realistic yearly figure in USD between $${minTuition} and $${maxTuition} for this region, varying sensibly by level.`,
    `Typical duration in months: Bachelor 36-48, Master 12-24, PhD 36-60, Diploma 12-18, Certificate 3-9.`,
  ]
    .filter((line) => line !== null)
    .join('\n')

  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    output_config: {
      format: zodOutputFormat(SyntheticProgramsSchema),
    },
  })

  return {
    programs: response.parsed_output?.programs ?? [],
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}

async function generateWithRetry(institution: Institution, total: number, maxRetries = 3): Promise<GenerationResult> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await generateProgramsForInstitution(institution, total)
    } catch (err) {
      lastError = err
      const isRateLimited = err instanceof Anthropic.RateLimitError
      const isServerError = err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError
      if ((isRateLimited || isServerError) && attempt < maxRetries) {
        const delayMs = 2000 * Math.pow(2, attempt)
        console.warn(`  Rate limited/server error for "${institution.name}", retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      throw err
    }
  }
  throw lastError
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - run this via `railway run --`')
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set - run this via `railway run --`')
  }

  const limitArg = process.argv[2] ? parseInt(process.argv[2], 10) : TOP_N_INSTITUTIONS
  const topN = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : TOP_N_INSTITUTIONS

  console.log(`Fetching top ${topN} institutions by student_count...`)
  const { data: institutionsData, error: institutionsError } = await supabase
    .from('institutions')
    .select('id, name, city, student_count, type:institution_types(name), country:countries(name, iso_code)')
    .eq('is_active', true)
    .order('student_count', { ascending: false, nullsFirst: false })
    .limit(topN)
  if (institutionsError) throw institutionsError
  const institutions = (institutionsData || []) as unknown as Institution[]

  console.log(`Checking existing program counts for ${institutions.length} institutions...`)
  const institutionIds = institutions.map((i) => i.id)
  const existingCounts = new Map<string, number>()
  const PAGE_SIZE = 1000
  for (let offset = 0; offset < institutionIds.length; offset += PAGE_SIZE) {
    const idsPage = institutionIds.slice(offset, offset + PAGE_SIZE)
    const { data: existingPrograms, error: existingError } = await supabase
      .from('programs')
      .select('institution_id')
      .in('institution_id', idsPage)
    if (existingError) throw existingError
    for (const p of existingPrograms || []) {
      existingCounts.set(p.institution_id, (existingCounts.get(p.institution_id) ?? 0) + 1)
    }
  }

  const toProcess = institutions.filter((i) => (existingCounts.get(i.id) ?? 0) < MIN_EXISTING_PROGRAMS_TO_SKIP)
  const skipped = institutions.length - toProcess.length
  console.log(`${toProcess.length} institutions need programs (${skipped} already have ${MIN_EXISTING_PROGRAMS_TO_SKIP}+ and are skipped).`)

  const { data: categoriesData, error: categoriesError } = await supabase.from('program_categories').select('id, name')
  if (categoriesError) throw categoriesError
  const categoryIdByName = new Map((categoriesData || []).map((c) => [c.name, c.id]))

  let totalGenerated = 0
  let totalFailed = 0
  let cumulativeCostUsd = 0
  const totalBatches = Math.ceil(toProcess.length / BATCH_SIZE)
  let stoppedForCost = false

  for (let batchIndex = 0; batchIndex < totalBatches && !stoppedForCost; batchIndex++) {
    const batch = toProcess.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE)

    for (const institution of batch) {
      if (cumulativeCostUsd >= COST_STOP_LIMIT_USD) {
        stoppedForCost = true
        break
      }

      const targetCount = MIN_PROGRAMS_PER_INSTITUTION + Math.floor(Math.random() * (MAX_PROGRAMS_PER_INSTITUTION - MIN_PROGRAMS_PER_INSTITUTION + 1))

      try {
        const { programs, inputTokens, outputTokens } = await generateWithRetry(institution, targetCount)
        cumulativeCostUsd += inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN

        const rows = programs
          .map((p) => {
            const categoryId = categoryIdByName.get(p.category)
            if (!categoryId) {
              console.warn(`  Skipping program with unrecognized category "${p.category}" for "${institution.name}"`)
              return null
            }
            const region = regionForIsoCode(institution.country?.iso_code)
            const [minTuition, maxTuition] = TUITION_RANGE_USD[region]
            return {
              name: p.name,
              slug: slugify(p.name, institution.id),
              institution_id: institution.id,
              category_id: categoryId,
              description: p.description,
              duration_months: p.duration_months,
              tuition_fees: clamp(p.tuition_fees, minTuition, maxTuition),
              currency: 'USD',
              level: p.level,
              mode: Math.random() < 0.85 ? 'Full-time' : 'Part-time',
              requirements: p.requirements,
              is_active: true,
              is_ai_generated: true,
              is_verified: false,
            }
          })
          .filter((row): row is NonNullable<typeof row> => row !== null)

        if (rows.length > 0) {
          const { error: insertError } = await supabase.from('programs').insert(rows)
          if (insertError) {
            console.error(`  Insert failed for "${institution.name}": ${insertError.message}`)
            totalFailed++
            continue
          }
        }

        totalGenerated += rows.length
        console.log(`Batch ${batchIndex + 1}/${totalBatches}: Generated ${rows.length} programs for ${institution.name} (running total: ${totalGenerated}, est. cost: $${cumulativeCostUsd.toFixed(2)})`)
      } catch (err: any) {
        totalFailed++
        console.error(`  Failed for "${institution.name}": ${err?.message || err}`)
      }
    }

    console.log(`--- Batch ${batchIndex + 1}/${totalBatches} complete. Total programs so far: ${totalGenerated}. Est. cost so far: $${cumulativeCostUsd.toFixed(2)} ---`)
  }

  console.log('')
  console.log('=== Generation complete ===')
  console.log(`Institutions processed: ${toProcess.length - totalFailed} succeeded, ${totalFailed} failed`)
  console.log(`Total synthetic programs inserted: ${totalGenerated}`)
  console.log(`Estimated total cost: $${cumulativeCostUsd.toFixed(2)}`)
  if (stoppedForCost) {
    console.log(`STOPPED EARLY: cumulative cost reached the $${COST_STOP_LIMIT_USD} limit. Re-run the script to continue - already-seeded institutions (5+ programs) are skipped automatically.`)
  }
}

main().catch((err) => {
  console.error('Generation failed:', err)
  process.exit(1)
})
