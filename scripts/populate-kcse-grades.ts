// Replaces the flat 'C-' placeholder (backfilled by
// elimux-frontend/grade-matcher-migration.sql) with a per-program AI
// estimate of the minimum KCSE grade, disclosed via
// programs.kcse_grade_is_estimated (see elimux-sql/33_...). Not a real
// cutoff from KUCCPS or any institution - a plausible estimate based on
// program name/level/field, following general Kenyan admission norms.
//
// Master's/PhD programs are cleared to null instead of estimated: Kenyan
// graduate admission is based on a prior degree, not a KCSE grade, so a
// KCSE requirement doesn't apply to them.
//
// Run via `railway run -- npx ts-node scripts/populate-kcse-grades.ts [limit]`
// so it picks up production SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// ANTHROPIC_API_KEY without those ever touching a local .env file.
//
// Optional [limit] caps how many programs to process - use a small number
// for a dry run before the full ~12,469.
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = 'claude-haiku-4-5'
const COST_PER_INPUT_TOKEN = 1.0 / 1_000_000
const COST_PER_OUTPUT_TOKEN = 5.0 / 1_000_000
const COST_STOP_LIMIT_USD = 20

const PAGE_SIZE = 1000
const ESTIMATE_BATCH_SIZE = 40 // programs per Haiku call
const DB_UPDATE_BATCH_SIZE = 100

const KCSE_GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'E'] as const
const GRADE_NUMERIC: Record<string, number> = {
  A: 12, 'A-': 11, 'B+': 10, B: 9, 'B-': 8, 'C+': 7, C: 6, 'C-': 5, 'D+': 4, D: 3, 'D-': 2, E: 1,
}
const GRADE_ELIGIBLE_LEVELS = new Set(['Bachelor', 'Diploma', 'Certificate'])

interface ProgramRow {
  id: string
  name: string
  level: string | null
  category: { name: string } | null
}

const EstimateSchema = z.object({
  grades: z.array(z.enum(KCSE_GRADES)),
})

const SYSTEM_PROMPT = `You estimate a plausible minimum KCSE (Kenya Certificate of Secondary Education) grade requirement for university/college/TVET programs, based on realistic Kenyan admission norms. These estimates are explicitly disclosed to end users as AI-estimated, not official cutoffs from KUCCPS or the institution - they exist to give a rough sense of competitiveness while real per-institution requirements are collected.

General Kenyan grade norms to follow:
- Highly competitive fields (Medicine, Engineering, Law, Actuarial Science, Architecture, Pharmacy) at Bachelor's level: B+ to A-
- Standard Bachelor's degree programs: C+ to B
- Diploma programs: C- to C+
- Certificate / craft / trade-level programs: D to D+
- Never go below E or above A.

Respond with exactly one grade per program, in the same order as the numbered list given, as the exact grade string (e.g. "B+", "C-").`

async function estimateBatch(
  programs: ProgramRow[]
): Promise<{ grades: string[]; inputTokens: number; outputTokens: number }> {
  const userMessage = [
    `Estimate a minimum KCSE grade for each of these ${programs.length} programs:`,
    ``,
    ...programs.map((p, i) => `${i + 1}. "${p.name}" — Level: ${p.level ?? 'Bachelor'}, Field: ${p.category?.name ?? 'General'}`),
  ].join('\n')

  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    output_config: { format: zodOutputFormat(EstimateSchema) },
  })

  return {
    grades: response.parsed_output?.grades ?? [],
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}

async function estimateBatchWithRetry(programs: ProgramRow[], maxRetries = 3) {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await estimateBatch(programs)
      if (result.grades.length !== programs.length) {
        throw new Error(`Grade count mismatch: got ${result.grades.length}, expected ${programs.length}`)
      }
      return result
    } catch (err) {
      lastError = err
      const isRateLimited = err instanceof Anthropic.RateLimitError
      const isServerError = err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError
      if ((isRateLimited || isServerError) && attempt < maxRetries) {
        const delayMs = 2000 * Math.pow(2, attempt)
        console.warn(`  Rate limited/server error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`)
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

  const limitArg = process.argv[2] ? parseInt(process.argv[2], 10) : undefined
  const limit = Number.isFinite(limitArg) && (limitArg as number) > 0 ? (limitArg as number) : undefined

  console.log('Fetching programs...')
  let allPrograms: ProgramRow[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('programs')
      .select('id, name, level, category:program_categories(name)')
      .eq('is_active', true)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    allPrograms = allPrograms.concat(data as unknown as ProgramRow[])
    if (data.length < PAGE_SIZE) break
    if (limit && allPrograms.length >= limit) break
  }
  if (limit) allPrograms = allPrograms.slice(0, limit)

  const gradeEligible = allPrograms.filter((p) => GRADE_ELIGIBLE_LEVELS.has(p.level ?? 'Bachelor'))
  const notEligible = allPrograms.filter((p) => !GRADE_ELIGIBLE_LEVELS.has(p.level ?? 'Bachelor'))
  console.log(
    `${allPrograms.length} programs total: ${gradeEligible.length} grade-eligible (Bachelor/Diploma/Certificate), ` +
      `${notEligible.length} postgraduate (Master/PhD - KCSE grade doesn't apply, will be cleared to null).`
  )

  if (notEligible.length > 0) {
    const CLEAR_BATCH = 100
    for (let i = 0; i < notEligible.length; i += CLEAR_BATCH) {
      const ids = notEligible.slice(i, i + CLEAR_BATCH).map((p) => p.id)
      const { error } = await supabase
        .from('programs')
        .update({ minimum_kcse_grade: null, minimum_kcse_grade_numeric: null, kcse_grade_is_estimated: false })
        .in('id', ids)
      if (error) console.error(`  Failed clearing batch: ${error.message}`)
    }
    console.log(`Cleared fake grades from ${notEligible.length} postgraduate programs.`)
  }

  let cumulativeCostUsd = 0
  let totalEstimated = 0
  let totalFailed = 0
  let stoppedForCost = false

  for (let i = 0; i < gradeEligible.length && !stoppedForCost; i += ESTIMATE_BATCH_SIZE) {
    if (cumulativeCostUsd >= COST_STOP_LIMIT_USD) {
      stoppedForCost = true
      break
    }

    const batch = gradeEligible.slice(i, i + ESTIMATE_BATCH_SIZE)
    try {
      const { grades, inputTokens, outputTokens } = await estimateBatchWithRetry(batch)
      cumulativeCostUsd += inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN

      const updates = batch.map((p, idx) => ({
        id: p.id,
        minimum_kcse_grade: grades[idx],
        minimum_kcse_grade_numeric: GRADE_NUMERIC[grades[idx]],
        kcse_grade_is_estimated: true,
      }))

      for (let u = 0; u < updates.length; u += DB_UPDATE_BATCH_SIZE) {
        const chunk = updates.slice(u, u + DB_UPDATE_BATCH_SIZE)
        const { error } = await supabase.from('programs').upsert(chunk, { onConflict: 'id' })
        if (error) {
          console.error(`  DB update failed for chunk: ${error.message}`)
          totalFailed += chunk.length
        } else {
          totalEstimated += chunk.length
        }
      }

      console.log(
        `  Batch ${Math.floor(i / ESTIMATE_BATCH_SIZE) + 1}/${Math.ceil(gradeEligible.length / ESTIMATE_BATCH_SIZE)}: ` +
          `${batch.length} estimated (cumulative cost: $${cumulativeCostUsd.toFixed(4)})`
      )
    } catch (err: any) {
      console.error(`  Batch failed: ${err.message}`)
      totalFailed += batch.length
    }
  }

  console.log(
    `\nDone. Estimated: ${totalEstimated}, Failed: ${totalFailed}, Postgraduate cleared: ${notEligible.length}, ` +
      `Cost: $${cumulativeCostUsd.toFixed(4)}${stoppedForCost ? ' (stopped: cost limit reached)' : ''}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
