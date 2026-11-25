// /api/attachments - attachment placements, logbook and evaluations.
// Slice 2 (Kimi-approved) authorization rewrite. Matrix:
//
//   route                       student  employer        institution  admin
//   GET    /                    own      own employer    own inst.    all
//   GET    /eligible-students   -        -               own inst.    -
//   POST   /                    -        -               own inst.    -
//          (eligible+not_placed student, no open placement, approved employer)
//   GET    /:id                 ✓        ✓               ✓            ✓
//   PUT    /:id                 403      403             ✓ (FSM)      ✓ (FSM)
//   DELETE /:id                 403      403             pending only pending only
//   GET    /:id/logbook         ✓        ✓               ✓            ✓
//   POST   /:id/logbook         active   403             403          403
//   GET    /:id/evaluation      ✓        ✓               ✓            ✓
//   POST   /:id/evaluation      403      completed,      403          403
//                                        non-viewer
//
// No relation to the attachment -> 404 (no existence leak). Related but
// action not allowed -> 403. Wrong lifecycle state -> 409. Bad input -> 400.
// Identity: verified JWT only (requireUser). Relationships: DB rows only
// (lib/authz/actor.ts). Bodies: strict zod allowlists, never spread.
import { Router, Request, Response, NextFunction, RequestHandler } from 'express'
import { supabase } from '../lib/supabase'
import { requireUser } from '../middleware/user-auth'
import { Actor, ActorSource, resolveActor } from '../lib/authz/actor'
import {
  AttachmentRow, AttachmentStore, AttachmentPatch, ConflictError, StudentSummary,
  createSupabaseActorSource, createSupabaseAttachmentStore,
} from '../lib/authz/attachment-store'
import {
  Relation, canManage, canRead, canWriteEvaluation, canWriteLogbook,
  detailsEditable, isAllowedTransition, relationsFor,
} from '../lib/authz/attachment-policy'
import {
  createAttachmentSchema, evaluationSchema, logbookEntrySchema, updateAttachmentSchema,
  uuidParam, validationDetails,
} from '../lib/validation/attachmentSchemas'

export interface AttachmentsRouterDeps {
  store: AttachmentStore
  actorSource: ActorSource
  /** Must verify the bearer JWT and set req.userId / req.userEmail. */
  authenticate: RequestHandler
  /** Today's date (YYYY-MM-DD) for logbook date checks; injectable for tests. */
  today?: () => string
}

/** Kenya-local calendar date, so an evening entry isn't rejected as "future". */
export function nairobiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date())
}

type Ctx = { actor: Actor; att: AttachmentRow; rel: Set<Relation> }

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message) }
}

function withStudent(rows: AttachmentRow[], summaries: Map<string, StudentSummary>) {
  return rows.map(r => {
    const s = r.student_id ? summaries.get(r.student_id) : undefined
    // Response shape kept compatible with the existing frontend
    // (student.email, student.raw_user_meta_data.full_name) but limited to
    // display fields - the full user_metadata object is no longer returned.
    return {
      ...r,
      student: s
        ? { id: s.id, email: s.email, raw_user_meta_data: { full_name: s.full_name, student_name: s.student_name } }
        : null,
    }
  })
}

export function createAttachmentsRouter(deps: AttachmentsRouterDeps): Router {
  const { store, actorSource, authenticate } = deps
  const today = deps.today ?? nairobiToday
  const router = Router()

  const handle = (name: string, fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        await fn(req, res)
      } catch (err: any) {
        if (err instanceof HttpError) {
          res.status(err.status).json(err.details ? { error: err.message, details: err.details } : { error: err.message })
          return
        }
        // Log server-side only; never return DB/driver messages to clients.
        console.error(`[attachments] ${name} failed:`, err?.message ?? err)
        res.status(500).json({ error: 'Server error' })
      }
    }

  async function actorFor(req: Request): Promise<Actor> {
    const userId = (req as any).userId as string | undefined
    if (!userId) throw new HttpError(401, 'Unauthorized')
    return resolveActor(actorSource, { id: userId, email: (req as any).userEmail ?? null })
  }

  /** Validates :id, loads the row, resolves relations. 404 unless related. */
  async function load(req: Request): Promise<Ctx> {
    const parsed = uuidParam.safeParse(req.params.id)
    if (!parsed.success) throw new HttpError(400, 'Invalid attachment id')
    const [actor, att] = await Promise.all([actorFor(req), store.getAttachment(parsed.data)])
    if (!att) throw new HttpError(404, 'Attachment not found')
    const rel = relationsFor(actor, att)
    if (!canRead(rel)) throw new HttpError(404, 'Attachment not found')
    return { actor, att, rel }
  }

  function parse<T>(schema: { safeParse(v: unknown): any }, body: unknown): T {
    const r = schema.safeParse(body ?? {})
    if (!r.success) throw new HttpError(400, 'Invalid request body', validationDetails(r.error))
    return r.data as T
  }

  /** The caller's single active institution (institution_accounts.user_id is UNIQUE). */
  function singleInstitution(actor: Actor): string {
    if (actor.institutionIds.length === 0) throw new HttpError(403, 'Active institution account required')
    if (actor.institutionIds.length > 1) throw new HttpError(409, 'Multiple active institution accounts; contact support')
    return actor.institutionIds[0]
  }

  router.use(authenticate)

  // ---------- list ----------
  router.get('/', handle('list', async (req, res) => {
    const actor = await actorFor(req)
    const rows = actor.isPlatformAdmin
      ? await store.listAttachments({ all: true })
      : await store.listAttachments({
          studentId: actor.userId,
          employerIds: actor.employers.map(e => e.employerId),
          institutionIds: actor.institutionIds,
        })
    const summaries = rows.length ? await store.getStudentSummaries(rows.map(r => r.student_id ?? '')) : new Map()
    res.json({ data: withStudent(rows, summaries) })
  }))

  // ---------- eligible students (must precede /:id) ----------
  router.get('/eligible-students', handle('eligible-students', async (req, res) => {
    const actor = await actorFor(req)
    const institutionId = singleInstitution(actor)
    res.json({ data: await store.listEligibleStudents(institutionId) })
  }))

  // ---------- create ----------
  router.post('/', handle('create', async (req, res) => {
    const actor = await actorFor(req)
    const institutionId = singleInstitution(actor)
    const b = parse<any>(createAttachmentSchema, req.body)
    // Student: must be on THIS institution's eligible list, status 'eligible',
    // attachment_status 'not_placed' - one message for every failure reason
    // so the response doesn't reveal other institutions' students.
    if (!(await store.isEligibleStudent(b.student_id, institutionId))) {
      throw new HttpError(400, 'Student is not eligible for attachment at this institution')
    }
    // Founder rule: at most one pending/active placement per student.
    // (Not race-proof without a DB constraint - SQL changes not yet approved.)
    if (await store.hasOpenPlacement(b.student_id)) {
      throw new HttpError(409, 'Student already has a pending or active placement')
    }
    // Employer: same rule as the assignment dropdown (GET /api/employers):
    // is_active = true AND verification_status = 'approved'. Nonexistent and
    // unapproved employers get the same 400 so IDs can't be probed.
    if (!(await store.isApprovedEmployer(b.employer_id))) {
      throw new HttpError(400, 'Employer is not an approved, active employer')
    }
    const data = await store.insertAttachment({
      student_id: b.student_id,
      university_id: institutionId,
      employer_id: b.employer_id,
      department: b.department ?? null,
      supervisor_name: b.supervisor_name ?? null,
      supervisor_email: b.supervisor_email ?? null,
      supervisor_phone: b.supervisor_phone ?? null,
      start_date: b.start_date,
      end_date: b.end_date ?? null,
      status: 'pending',
    })
    res.status(201).json({ data })
  }))

  // ---------- read one ----------
  router.get('/:id', handle('get', async (req, res) => {
    const { att } = await load(req)
    const summaries = att.student_id ? await store.getStudentSummaries([att.student_id]) : new Map()
    res.json({ data: withStudent([att], summaries)[0] })
  }))

  // ---------- update (institution / admin; lifecycle FSM) ----------
  router.put('/:id', handle('update', async (req, res) => {
    const { att, rel } = await load(req)
    if (!canManage(rel)) throw new HttpError(403, 'Only the placement institution can update it')
    const b = parse<any>(updateAttachmentSchema, req.body)

    if (b.status !== undefined && !isAllowedTransition(att.status, b.status)) {
      throw new HttpError(409, `Cannot change status from '${att.status}' to '${b.status}'`)
    }
    const detailKeys = ['department', 'supervisor_name', 'supervisor_email', 'supervisor_phone', 'start_date', 'end_date']
      .filter(k => b[k] !== undefined)
    if (detailKeys.length && !detailsEditable(att.status)) {
      throw new HttpError(409, `Placement details cannot be edited when status is '${att.status}'`)
    }
    const start = b.start_date ?? att.start_date
    const end = b.end_date !== undefined ? b.end_date : att.end_date
    if (end && start && end < start) throw new HttpError(400, 'end_date must be on or after start_date')

    // Explicit field copy - never spread the request body.
    const patch: AttachmentPatch = {}
    if (b.status !== undefined) patch.status = b.status
    if (b.certificate_issued === true) patch.certificate_issued = true
    for (const k of detailKeys) (patch as any)[k] = b[k]

    const data = await store.updateAttachmentIfStatus(att.id, att.status, patch)
    if (!data) throw new HttpError(409, 'Placement was changed by someone else; reload and retry')
    res.json({ data })
  }))

  // ---------- delete (pending, no history only) ----------
  router.delete('/:id', handle('delete', async (req, res) => {
    const { att, rel } = await load(req)
    if (!canManage(rel)) throw new HttpError(403, 'Only the placement institution can delete it')
    if (att.status !== 'pending') {
      throw new HttpError(409, "Only pending placements can be deleted; set status 'terminated' instead")
    }
    const [entries, evaluation] = await Promise.all([store.countLogbookEntries(att.id), store.getEvaluation(att.id)])
    if (entries > 0 || evaluation) {
      throw new HttpError(409, "Placement has logbook or evaluation records; set status 'terminated' instead")
    }
    if (!(await store.deletePendingAttachment(att.id))) {
      throw new HttpError(409, 'Placement was changed by someone else; reload and retry')
    }
    res.json({ success: true })
  }))

  // ---------- logbook ----------
  router.get('/:id/logbook', handle('logbook-list', async (req, res) => {
    const { att } = await load(req)
    res.json({ data: await store.listLogbook(att.id) })
  }))

  router.post('/:id/logbook', handle('logbook-create', async (req, res) => {
    const { att, rel } = await load(req)
    if (!canWriteLogbook(rel)) throw new HttpError(403, 'Only the placed student can write logbook entries')
    if (att.status !== 'active') throw new HttpError(409, 'Logbook entries can only be added to an active placement')
    const b = parse<any>(logbookEntrySchema, req.body)
    if (b.entry_date > today()) throw new HttpError(400, 'entry_date cannot be in the future')
    if (att.start_date && b.entry_date < att.start_date) throw new HttpError(400, 'entry_date is before the placement start date')
    if (att.end_date && b.entry_date > att.end_date) throw new HttpError(400, 'entry_date is after the placement end date')

    // Same columns the previous handler wrote - no schema change in this slice.
    const data = await store.insertLogbook({
      attachment_id: att.id,
      entry_date: b.entry_date,
      week_number: b.week_number ?? null,
      tasks_completed: b.tasks_completed,
      skills_learned: b.skills_learned ?? null,
      challenges_faced: b.challenges_faced ?? null,
      hours_worked: b.hours_worked ?? 0,
    })
    res.status(201).json({ data })
  }))

  // ---------- evaluation ----------
  router.get('/:id/evaluation', handle('evaluation-get', async (req, res) => {
    const { att } = await load(req)
    res.json({ data: await store.getEvaluation(att.id) })
  }))

  router.post('/:id/evaluation', handle('evaluation-create', async (req, res) => {
    const { actor, att } = await load(req)
    if (!canWriteEvaluation(actor, att)) throw new HttpError(403, "Only the placement's employer can evaluate")
    if (att.status !== 'completed') throw new HttpError(409, 'Evaluations can only be submitted for completed placements')
    if (await store.getEvaluation(att.id)) throw new HttpError(409, 'An evaluation already exists for this placement')
    const b = parse<any>(evaluationSchema, req.body)

    let data
    try {
      data = await store.insertEvaluation({
        attachment_id: att.id,              // from the URL-loaded row
        employer_id: att.employer_id,       // from the DB, never the body
        punctuality_score: b.punctuality_score ?? null,
        teamwork_score: b.teamwork_score ?? null,
        communication_score: b.communication_score ?? null,
        technical_skills_score: b.technical_skills_score ?? null,
        initiative_score: b.initiative_score ?? null,
        overall_score: b.overall_score,
        strengths: b.strengths ?? null,
        areas_for_improvement: b.areas_for_improvement ?? null,
        recommendation: b.recommendation ?? null,
      })
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, 'An evaluation already exists for this placement')
      throw e
    }
    await store.setEvaluationScore(att.id, b.overall_score)
    res.status(201).json({ data })
  }))

  return router
}

// Production wiring: shared service-role client + verified-JWT middleware.
export default createAttachmentsRouter({
  store: createSupabaseAttachmentStore(supabase),
  actorSource: createSupabaseActorSource(supabase),
  authenticate: requireUser as unknown as RequestHandler,
})
