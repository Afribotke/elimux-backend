// Attachment authorization policy - pure functions, no I/O.
// Single source of truth for the Kimi-approved matrix (Slice 2).
import type { Actor } from './actor'

export type AttachmentStatus = 'pending' | 'active' | 'completed' | 'terminated'

export interface AttachmentOwnership {
  student_id: string | null
  employer_id: string | null
  university_id: string | null
  status: string
}

export type Relation = 'student' | 'employer' | 'institution' | 'admin'

/** Employer team roles that are read-only elsewhere in this codebase
 *  (internships.ts rejects 'viewer' writes); they can read but not evaluate. */
const EMPLOYER_READ_ONLY_ROLES = new Set(['viewer'])

export function relationsFor(actor: Actor, att: AttachmentOwnership): Set<Relation> {
  const rel = new Set<Relation>()
  if (att.student_id && att.student_id === actor.userId) rel.add('student')
  if (att.employer_id && actor.employers.some(m => m.employerId === att.employer_id)) rel.add('employer')
  if (att.university_id && actor.institutionIds.includes(att.university_id)) rel.add('institution')
  if (actor.isPlatformAdmin) rel.add('admin')
  return rel
}

/** Any relation at all may read the attachment, its logbook and evaluation. */
export function canRead(rel: Set<Relation>): boolean {
  return rel.size > 0
}

/** Institution of the attachment, or platform admin. */
export function canManage(rel: Set<Relation>): boolean {
  return rel.has('institution') || rel.has('admin')
}

/** Only the attachment's own student; status must be checked separately. */
export function canWriteLogbook(rel: Set<Relation>): boolean {
  return rel.has('student')
}

/** The attachment's employer, via owner or a non-read-only team role. */
export function canWriteEvaluation(actor: Actor, att: AttachmentOwnership): boolean {
  if (!att.employer_id) return false
  const m = actor.employers.find(e => e.employerId === att.employer_id)
  return !!m && !EMPLOYER_READ_ONLY_ROLES.has(m.role)
}

const TRANSITIONS: Record<string, AttachmentStatus[]> = {
  pending: ['active', 'terminated'],
  active: ['completed', 'terminated'],
  completed: [],
  terminated: [],
}

export function isAllowedTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to as AttachmentStatus)
}

/** Detail fields (department, supervisor, dates) are editable only while the
 *  placement is still live. */
export function detailsEditable(status: string): boolean {
  return status === 'pending' || status === 'active'
}
