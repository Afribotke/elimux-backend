// Strict request-body allowlists for /api/attachments (Slice 2).
// Every schema is .strict(): unknown keys (e.g. university_id, student_id on
// update, evaluation_score, certificate_url, employer_id on evaluation) are
// REJECTED with 400, never silently passed through to the database.
import { z } from 'zod'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD that is a real calendar date (rejects 2026-02-30). */
export const isoDate = z.string().regex(ISO_DATE, 'Expected YYYY-MM-DD').refine(v => {
  const d = new Date(`${v}T00:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}, 'Invalid calendar date')

/** HTML forms send "" for empty optional inputs; treat that as null. */
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const optText = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional())
const optDate = z.preprocess(emptyToNull, isoDate.nullable().optional())
const optEmail = z.preprocess(emptyToNull, z.email().max(254).nullable().optional())
const optPhone = z.preprocess(
  emptyToNull,
  z.string().trim().max(30).regex(/^[+0-9 ()-]+$/, 'Invalid phone number').nullable().optional()
)

export const uuidParam = z.uuid()

// POST /api/attachments - university_id is NEVER accepted; it is derived from
// the caller's active institution_accounts row. status is NEVER accepted; new
// attachments always start as 'pending'.
export const createAttachmentSchema = z
  .object({
    student_id: z.uuid(),
    employer_id: z.uuid(),
    department: optText(200),
    supervisor_name: optText(200),
    supervisor_email: optEmail,
    supervisor_phone: optPhone,
    start_date: isoDate,
    end_date: optDate,
  })
  .strict()
  .refine(b => !b.end_date || b.end_date >= b.start_date, {
    message: 'end_date must be on or after start_date',
    path: ['end_date'],
  })

// PUT /api/attachments/:id - institution / platform admin only.
// Ownership fields (student_id, employer_id, university_id), evaluation_score,
// certificate_url, timestamps: not in the allowlist -> 400.
export const updateAttachmentSchema = z
  .object({
    status: z.enum(['active', 'completed', 'terminated']).optional(),
    certificate_issued: z.literal(true).optional(),
    department: optText(200),
    supervisor_name: optText(200),
    supervisor_email: optEmail,
    supervisor_phone: optPhone,
    start_date: isoDate.optional(),
    end_date: optDate,
  })
  .strict()
  .refine(b => Object.keys(b).length > 0, { message: 'No updatable fields supplied' })
  .refine(b => b.certificate_issued === undefined || b.status === 'completed', {
    message: "certificate_issued may only be set together with status 'completed'",
    path: ['certificate_issued'],
  })

// POST /api/attachments/:id/logbook - student only.
export const logbookEntrySchema = z
  .object({
    entry_date: isoDate,
    week_number: z.preprocess(emptyToNull, z.number().int().min(1).max(53).nullable().optional()),
    tasks_completed: z.string().trim().min(1, 'tasks_completed is required').max(5000),
    skills_learned: optText(5000),
    challenges_faced: optText(5000),
    // logbook_entries.hours_worked is INTEGER in the live DB (confirmed 2026-11-26).
    hours_worked: z.preprocess(emptyToNull, z.number().int().min(0).max(24).nullable().optional()),
  })
  .strict()

// POST /api/attachments/:id/evaluation - employer only. attachment_id and
// employer_id come from the URL / DB, never the body.
const score10 = z.preprocess(emptyToNull, z.number().int().min(0).max(10).nullable().optional())
export const evaluationSchema = z
  .object({
    punctuality_score: score10,
    teamwork_score: score10,
    communication_score: score10,
    technical_skills_score: score10,
    initiative_score: score10,
    overall_score: z.number().int().min(0).max(100),
    strengths: optText(5000),
    areas_for_improvement: optText(5000),
    recommendation: z.preprocess(
      emptyToNull,
      z.enum(['highly_recommend', 'recommend', 'neutral', 'not_recommend']).nullable().optional()
    ),
  })
  .strict()

/** Field-level messages only - never echoes submitted values. */
export function validationDetails(err: z.ZodError): Array<{ field: string; message: string }> {
  return err.issues.map(i => ({ field: i.path.join('.') || '(body)', message: i.message }))
}
