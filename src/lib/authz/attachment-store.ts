// Data access for the attachments module. Routes depend only on these
// interfaces; the Supabase implementation below is the production wiring and
// tests inject an in-memory implementation. All methods THROW on query errors
// (fail closed) - callers turn that into a generic 500.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActorSource } from './actor'
import { hasDbAdminRole } from '../../middleware/auth'

export interface AttachmentRow {
  id: string
  student_id: string | null
  university_id: string | null
  employer_id: string | null
  department: string | null
  supervisor_name: string | null
  supervisor_email: string | null
  supervisor_phone: string | null
  start_date: string
  end_date: string | null
  status: string
  evaluation_score: number | null
  certificate_issued: boolean | null
  certificate_url: string | null
  created_at?: string
  updated_at?: string
  university?: { id: string; name: string } | null
  employer?: { id: string; company_name: string } | null
}

export interface AttachmentInsert {
  student_id: string
  university_id: string
  employer_id: string
  department: string | null
  supervisor_name: string | null
  supervisor_email: string | null
  supervisor_phone: string | null
  start_date: string
  end_date: string | null
  status: 'pending'
}

export type AttachmentPatch = Partial<{
  status: string
  certificate_issued: boolean
  department: string | null
  supervisor_name: string | null
  supervisor_email: string | null
  supervisor_phone: string | null
  start_date: string
  end_date: string | null
}>

export interface ListScope {
  all?: boolean
  studentId?: string
  employerIds?: string[]
  institutionIds?: string[]
}

export interface StudentSummary {
  id: string
  email?: string
  full_name?: string
  student_name?: string
}

export class ConflictError extends Error {}

export interface AttachmentStore {
  getAttachment(id: string): Promise<AttachmentRow | null>
  listAttachments(scope: ListScope): Promise<AttachmentRow[]>
  /** Eligible = row with user_id, caller's institution_id, status 'eligible',
   *  attachment_status 'not_placed'. */
  isEligibleStudent(studentUserId: string, institutionId: string): Promise<boolean>
  /** Student already has a 'pending' or 'active' placement (any institution). */
  hasOpenPlacement(studentUserId: string): Promise<boolean>
  listEligibleStudents(institutionId: string): Promise<Array<Record<string, unknown>>>
  /** Same rule as the employer-assignment dropdown (GET /api/employers in
   *  internships.ts): is_active = true AND verification_status = 'approved'. */
  isApprovedEmployer(employerId: string): Promise<boolean>
  /** Throws ConflictError on unique violation (student already has an open placement). */
  insertAttachment(row: AttachmentInsert): Promise<AttachmentRow>
  /** Conditional update: applies only if the row still has expectedStatus. */
  updateAttachmentIfStatus(id: string, expectedStatus: string, patch: AttachmentPatch): Promise<AttachmentRow | null>
  /** Deletes only if status is still 'pending'. Returns whether a row was deleted. */
  deletePendingAttachment(id: string): Promise<boolean>
  countLogbookEntries(attachmentId: string): Promise<number>
  listLogbook(attachmentId: string): Promise<Array<Record<string, unknown>>>
  insertLogbook(row: Record<string, unknown>): Promise<Record<string, unknown>>
  getEvaluation(attachmentId: string): Promise<Record<string, unknown> | null>
  /** Throws ConflictError if an evaluation already exists (unique violation). */
  insertEvaluation(row: Record<string, unknown>): Promise<Record<string, unknown>>
  setEvaluationScore(attachmentId: string, score: number): Promise<void>
  getStudentSummaries(ids: string[]): Promise<Map<string, StudentSummary>>
}

const ATTACHMENT_SELECT =
  'id, student_id, university_id, employer_id, department, supervisor_name, supervisor_email, supervisor_phone, ' +
  'start_date, end_date, status, evaluation_score, certificate_issued, certificate_url, created_at, updated_at, ' +
  'university:university_id(id, name), employer:employer_id(id, company_name)'

const ELIGIBLE_SELECT =
  'id, user_id, student_name, registration_number, email, course, department, year_of_study, status, attachment_status'

function check<T>(res: { data: T; error: any }): T {
  if (res.error) throw new Error(`store query failed: ${res.error.code ?? 'unknown'}`)
  return res.data
}

// UUIDs reach .or() filters only after coming from DB rows or z.uuid()
// validation, so they can't inject PostgREST syntax; asserted here anyway.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function uuidList(ids: string[]): string {
  for (const id of ids) if (!UUID_RE.test(id)) throw new Error('non-uuid id in filter')
  return ids.join(',')
}

export function createSupabaseAttachmentStore(db: SupabaseClient): AttachmentStore {
  return {
    async getAttachment(id) {
      return check(await db.from('attachments').select(ATTACHMENT_SELECT).eq('id', id).maybeSingle()) as AttachmentRow | null
    },

    async listAttachments(scope) {
      let q = db.from('attachments').select(ATTACHMENT_SELECT)
      if (!scope.all) {
        const parts: string[] = []
        if (scope.studentId) parts.push(`student_id.eq.${uuidList([scope.studentId])}`)
        if (scope.employerIds?.length) parts.push(`employer_id.in.(${uuidList(scope.employerIds)})`)
        if (scope.institutionIds?.length) parts.push(`university_id.in.(${uuidList(scope.institutionIds)})`)
        if (parts.length === 0) return []
        q = q.or(parts.join(','))
      }
      return (check(await q.order('created_at', { ascending: false })) ?? []) as unknown as AttachmentRow[]
    },

    async isEligibleStudent(studentUserId, institutionId) {
      const rows = check(
        await db.from('attachment_eligible_students').select('id')
          .eq('user_id', studentUserId)
          .eq('institution_id', institutionId)
          .eq('status', 'eligible')
          .eq('attachment_status', 'not_placed')
          .limit(1)
      )
      return (rows ?? []).length > 0
    },

    async hasOpenPlacement(studentUserId) {
      const rows = check(
        await db.from('attachments').select('id')
          .eq('student_id', studentUserId).in('status', ['pending', 'active']).limit(1)
      )
      return (rows ?? []).length > 0
    },

    async listEligibleStudents(institutionId) {
      return check(
        await db.from('attachment_eligible_students').select(ELIGIBLE_SELECT)
          .eq('institution_id', institutionId)
          .eq('status', 'eligible')
          .eq('attachment_status', 'not_placed')
          .order('student_name', { ascending: true })
      ) ?? []
    },

    async isApprovedEmployer(employerId) {
      const rows = check(
        await db.from('employers').select('id')
          .eq('id', employerId).eq('is_active', true).eq('verification_status', 'approved').limit(1)
      )
      return (rows ?? []).length > 0
    },

    async insertAttachment(row) {
      const res = await db.from('attachments').insert(row).select(ATTACHMENT_SELECT).single()
      // L-06: a unique violation means the student already has an open
      // placement (the race the hasOpenPlacement pre-check can't close; draft
      // index 62 enforces it in the DB). Must ship before 62 is applied.
      if (res.error?.code === '23505') throw new ConflictError('open placement already exists')
      return check(res) as unknown as AttachmentRow
    },

    async updateAttachmentIfStatus(id, expectedStatus, patch) {
      const rows = check(
        await db.from('attachments').update(patch).eq('id', id).eq('status', expectedStatus).select(ATTACHMENT_SELECT)
      ) as unknown as AttachmentRow[] | null
      return rows && rows.length ? rows[0] : null
    },

    async deletePendingAttachment(id) {
      const rows = check(await db.from('attachments').delete().eq('id', id).eq('status', 'pending').select('id'))
      return (rows ?? []).length > 0
    },

    async countLogbookEntries(attachmentId) {
      const res = await db.from('logbook_entries').select('id', { count: 'exact', head: true }).eq('attachment_id', attachmentId)
      if (res.error) throw new Error(`store query failed: ${res.error.code ?? 'unknown'}`)
      return res.count ?? 0
    },

    async listLogbook(attachmentId) {
      return check(
        await db.from('logbook_entries').select('*').eq('attachment_id', attachmentId).order('entry_date', { ascending: false })
      ) ?? []
    },

    async insertLogbook(row) {
      const inserted = check(await db.from('logbook_entries').insert(row).select().single())
      if (!inserted) throw new Error('store query failed: insert returned no row')
      return inserted
    },

    async getEvaluation(attachmentId) {
      const rows = check(
        await db.from('attachment_evaluations').select('*').eq('attachment_id', attachmentId)
          .order('created_at', { ascending: true }).limit(1)
      )
      return rows && rows.length ? rows[0] : null
    },

    async insertEvaluation(row) {
      const res = await db.from('attachment_evaluations').insert(row).select().single()
      if (res.error?.code === '23505') throw new ConflictError('evaluation already exists')
      const inserted = check(res)
      if (!inserted) throw new Error('store query failed: insert returned no row')
      return inserted
    },

    async setEvaluationScore(attachmentId, score) {
      check(await db.from('attachments').update({ evaluation_score: score }).eq('id', attachmentId))
    },

    async getStudentSummaries(ids) {
      const unique = [...new Set(ids.filter(Boolean))]
      const users = await Promise.all(unique.map(id => db.auth.admin.getUserById(id).catch(() => null)))
      const out = new Map<string, StudentSummary>()
      unique.forEach((id, i) => {
        const u = users[i]?.data?.user
        if (!u) return
        // Display fields only - never the full user_metadata object.
        out.set(id, {
          id,
          email: u.email ?? undefined,
          full_name: typeof u.user_metadata?.full_name === 'string' ? u.user_metadata.full_name : undefined,
          student_name: typeof u.user_metadata?.student_name === 'string' ? u.user_metadata.student_name : undefined,
        })
      })
      return out
    },
  }
}

export function createSupabaseActorSource(db: SupabaseClient): ActorSource {
  return {
    async ownedEmployerIds(userId) {
      const rows = check(await db.from('employers').select('id').eq('user_id', userId)) as Array<{ id: string }> | null
      return (rows ?? []).map(r => r.id)
    },
    async activeTeamMemberships(userId) {
      const rows = check(
        await db.from('employer_team_members').select('employer_id, role').eq('user_id', userId).eq('is_active', true)
      ) as Array<{ employer_id: string; role: string }> | null
      return (rows ?? []).map(r => ({ employerId: r.employer_id, role: r.role }))
    },
    async activeInstitutionIds(userId) {
      const rows = check(
        await db.from('institution_accounts').select('institution_id').eq('user_id', userId).eq('status', 'active')
      ) as Array<{ institution_id: string }> | null
      return (rows ?? []).map(r => r.institution_id).filter(Boolean)
    },
    async isPlatformAdmin(user) {
      return hasDbAdminRole(user)
    },
  }
}
