// Slice 2 authorization tests for /api/attachments.
// Real Express router over real HTTP (localhost, random port) with an
// in-memory AttachmentStore/ActorSource. No Supabase, no network, no keys.
// The test authenticate() stands in for requireUser (JWT verification is
// covered separately); it only maps a test header to a verified user id.
process.env.SUPABASE_URL = 'http://127.0.0.1:9'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_dummy_for_unit_tests_only'

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createAttachmentsRouter } = require('../src/routes/attachments')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveActor } = require('../src/lib/authz/actor')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConflictError } = require('../src/lib/authz/attachment-store')

// ---------------- fixtures ----------------
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const U = {
  studentA1: id(1), studentA2: id(2), studentB1: id(3),
  empOwnerA: id(10), empTeamA: id(11), empViewerA: id(12), empOwnerB: id(13), empInactiveA: id(14),
  instA: id(20), instB: id(21), instPending: id(22), instMulti: id(23),
  admin: id(30), metaAdmin: id(31), stranger: id(32), multiRoleAdmin: id(33),
  studentA3Fresh: id(40), studentA4Ineligible: id(41), studentA5Placed: id(42), studentA6FinishedEarlier: id(43),
}
const IA = id(100), IB = id(101), EA = id(200), EB = id(201)
// Employer approval states (rule: is_active = true AND verification_status = 'approved')
const E_PENDING = id(210), E_UNDER_REVIEW = id(211), E_REJECTED = id(212), E_INACTIVE = id(213), E_NULL_STATUS = id(214)
const ATT = { a1Active: id(300), a2Pending: id(301), b1Completed: id(302), a1Completed: id(303) }
const TODAY = '2026-11-25'

type Row = Record<string, any>
let attachments: Row[] = []
let logbook: Row[] = []
let evaluations: Row[] = []
let eligible: Row[] = []
let employers: Row[] = []
let failNextQuery = false

function seed() {
  const base = { department: 'ICT', supervisor_name: 'S', supervisor_email: 's@example.com', supervisor_phone: '+254700000000',
    evaluation_score: null, certificate_issued: false, certificate_url: null }
  attachments = [
    { ...base, id: ATT.a1Active, student_id: U.studentA1, employer_id: EA, university_id: IA, status: 'active', start_date: '2026-09-01', end_date: null },
    { ...base, id: ATT.a2Pending, student_id: U.studentA2, employer_id: EA, university_id: IA, status: 'pending', start_date: '2026-12-01', end_date: null },
    { ...base, id: ATT.b1Completed, student_id: U.studentB1, employer_id: EB, university_id: IB, status: 'completed', start_date: '2026-01-01', end_date: '2026-03-31' },
    { ...base, id: ATT.a1Completed, student_id: U.studentA1, employer_id: EA, university_id: IA, status: 'completed', start_date: '2026-01-01', end_date: '2026-03-31' },
  ]
  logbook = []
  evaluations = []
  eligible = [
    { id: id(400), user_id: U.studentA1, institution_id: IA, student_name: 'A1', status: 'eligible', attachment_status: 'not_placed' },
    { id: id(401), user_id: U.studentA2, institution_id: IA, student_name: 'A2', status: 'eligible', attachment_status: 'not_placed' },
    { id: id(402), user_id: id(5), institution_id: IA, student_name: 'Placed', status: 'eligible', attachment_status: 'completed' },
    { id: id(403), user_id: U.studentB1, institution_id: IB, student_name: 'B1', status: 'eligible', attachment_status: 'not_placed' },
    { id: id(404), user_id: U.studentA3Fresh, institution_id: IA, student_name: 'A3', status: 'eligible', attachment_status: 'not_placed' },
    { id: id(405), user_id: U.studentA4Ineligible, institution_id: IA, student_name: 'A4', status: 'ineligible', attachment_status: 'not_placed' },
    { id: id(406), user_id: U.studentA5Placed, institution_id: IA, student_name: 'A5', status: 'eligible', attachment_status: 'accepted' },
    // eligible + not_placed, but with an earlier COMPLETED placement only -> may be placed again
    { id: id(407), user_id: U.studentA6FinishedEarlier, institution_id: IA, student_name: 'A6', status: 'eligible', attachment_status: 'not_placed' },
  ]
  employers = [
    { id: EA, is_active: true, verification_status: 'approved' },
    { id: EB, is_active: true, verification_status: 'approved' },
    { id: E_PENDING, is_active: true, verification_status: 'pending' },
    { id: E_UNDER_REVIEW, is_active: true, verification_status: 'under_review' },
    { id: E_REJECTED, is_active: true, verification_status: 'rejected' },
    { id: E_INACTIVE, is_active: false, verification_status: 'approved' },
    { id: E_NULL_STATUS, is_active: true, verification_status: null },
  ]
  attachments.push({ ...base, id: id(304), student_id: U.studentA6FinishedEarlier, employer_id: EA, university_id: IA,
    status: 'completed', start_date: '2025-01-01', end_date: '2025-03-31' })
  failNextQuery = false
}

const maybeFail = () => { if (failNextQuery) { failNextQuery = false; throw new Error('pg: relation "secret_internal_table" does not exist') } }

const store = {
  async getAttachment(aid: string) { maybeFail(); const r = attachments.find(a => a.id === aid); return r ? { ...r } : null },
  async listAttachments(scope: any) {
    maybeFail()
    if (scope.all) return attachments.map(a => ({ ...a }))
    return attachments.filter(a =>
      a.student_id === scope.studentId ||
      (scope.employerIds ?? []).includes(a.employer_id) ||
      (scope.institutionIds ?? []).includes(a.university_id)).map(a => ({ ...a }))
  },
  async isEligibleStudent(uid: string, inst: string) {
    return eligible.some(e => e.user_id === uid && e.institution_id === inst && e.status === 'eligible' && e.attachment_status === 'not_placed')
  },
  async hasOpenPlacement(uid: string) { return attachments.some(a => a.student_id === uid && ['pending', 'active'].includes(a.status)) },
  async listEligibleStudents(inst: string) {
    return eligible.filter(e => e.institution_id === inst && e.status === 'eligible' && e.attachment_status === 'not_placed')
  },
  async isApprovedEmployer(eid: string) { return employers.some(e => e.id === eid && e.is_active === true && e.verification_status === 'approved') },
  async insertAttachment(row: Row) { const r = { id: id(900 + attachments.length), evaluation_score: null, certificate_issued: false, certificate_url: null, ...row }; attachments.push(r); return { ...r } },
  async updateAttachmentIfStatus(aid: string, expected: string, patch: Row) {
    const r = attachments.find(a => a.id === aid && a.status === expected)
    if (!r) return null
    Object.assign(r, patch)
    return { ...r }
  },
  async deletePendingAttachment(aid: string) {
    const before = attachments.length
    attachments = attachments.filter(a => !(a.id === aid && a.status === 'pending'))
    return attachments.length < before
  },
  async countLogbookEntries(aid: string) { return logbook.filter(l => l.attachment_id === aid).length },
  async listLogbook(aid: string) { return logbook.filter(l => l.attachment_id === aid) },
  async insertLogbook(row: Row) { const r = { id: id(700 + logbook.length), ...row }; logbook.push(r); return r },
  async getEvaluation(aid: string) { return evaluations.find(e => e.attachment_id === aid) ?? null },
  async insertEvaluation(row: Row) {
    if (evaluations.some(e => e.attachment_id === row.attachment_id && e.employer_id === row.employer_id)) throw new ConflictError('dup')
    const r = { id: id(800 + evaluations.length), ...row }; evaluations.push(r); return r
  },
  async setEvaluationScore(aid: string, score: number) { const r = attachments.find(a => a.id === aid); if (r) r.evaluation_score = score },
  async getStudentSummaries(ids: string[]) {
    return new Map(ids.filter(Boolean).map(i => [i, { id: i, email: `${i.slice(-2)}@example.com`, full_name: `Student ${i.slice(-2)}` }]))
  },
}

const actorSource = {
  async ownedEmployerIds(uid: string) { return ({ [U.empOwnerA]: [EA], [U.empOwnerB]: [EB] } as Record<string, string[]>)[uid] ?? [] },
  async activeTeamMemberships(uid: string) {
    return ({ [U.empTeamA]: [{ employerId: EA, role: 'supervisor' }], [U.empViewerA]: [{ employerId: EA, role: 'viewer' }] } as Record<string, any[]>)[uid] ?? []
  },
  async activeInstitutionIds(uid: string) {
    return ({ [U.instA]: [IA], [U.instB]: [IB], [U.instMulti]: [IA, IB] } as Record<string, string[]>)[uid] ?? []
  },
  // metaAdmin would have user_metadata.role='admin' - irrelevant: only DB evidence counts.
  async isPlatformAdmin(u: { id: string }) { return u.id === U.admin || u.id === U.multiRoleAdmin },
}

const authenticate = (req: any, res: any, next: any) => {
  const uid = req.headers['x-test-user']
  if (!uid) return res.status(401).json({ success: false, error: 'Unauthorized - No token provided' })
  req.userId = uid
  req.userEmail = `${uid}@example.com`
  next()
}

let server: Server
let base = ''
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/attachments', createAttachmentsRouter({ store, actorSource, authenticate, today: () => TODAY }))
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attachments`
})
after(() => server.close())
beforeEach(seed)

async function call(user: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text }
}
const att = (aid: string) => attachments.find(a => a.id === aid)
const snapshot = () => JSON.stringify({ attachments, logbook, evaluations })

// ---------------- authentication / input ----------------
test('no credentials -> 401 on every route', async () => {
  for (const [m, p] of [['GET', '/'], ['GET', `/${ATT.a1Active}`], ['PUT', `/${ATT.a1Active}`], ['POST', `/${ATT.a1Active}/logbook`]]) {
    assert.equal((await call(null, m, p, m === 'GET' ? undefined : {})).status, 401, `${m} ${p}`)
  }
})

test('malformed :id -> 400; unknown uuid -> 404', async () => {
  assert.equal((await call(U.admin, 'GET', '/not-a-uuid')).status, 400)
  assert.equal((await call(U.admin, 'GET', "/1' or '1'='1")).status, 400)
  assert.equal((await call(U.admin, 'GET', `/${id(999)}`)).status, 404)
})

// ---------------- read: GET /:id ----------------
test('GET /:id - every related party can read; unrelated parties get 404 (no existence leak)', async () => {
  for (const u of [U.studentA1, U.empOwnerA, U.empTeamA, U.empViewerA, U.instA, U.admin, U.multiRoleAdmin]) {
    assert.equal((await call(u, 'GET', `/${ATT.a1Active}`)).status, 200, u)
  }
  for (const u of [U.studentA2, U.studentB1, U.empOwnerB, U.empInactiveA, U.instB, U.instPending, U.stranger, U.metaAdmin]) {
    const r = await call(u, 'GET', `/${ATT.a1Active}`)
    assert.equal(r.status, 404, u)
    assert.deepEqual(r.body, { error: 'Attachment not found' })
  }
})

test('GET /:id returns student display fields only, not the full user_metadata', async () => {
  const r = await call(U.studentA1, 'GET', `/${ATT.a1Active}`)
  assert.deepEqual(Object.keys(r.body.data.student).sort(), ['email', 'id', 'raw_user_meta_data'])
  // only display-name keys may appear (absent ones are dropped by JSON)
  for (const k of Object.keys(r.body.data.student.raw_user_meta_data)) assert.ok(['full_name', 'student_name'].includes(k), k)
  assert.equal(r.body.data.student.raw_user_meta_data.full_name, 'Student 01')
})

// ---------------- list ----------------
test('GET / is scoped per actor (cross-user and cross-tenant)', async () => {
  const ids = async (u: string) => ((await call(u, 'GET', '/')).body.data as Row[]).map(r => r.id).sort()
  assert.deepEqual(await ids(U.studentA1), [ATT.a1Active, ATT.a1Completed].sort())
  assert.deepEqual(await ids(U.studentA2), [ATT.a2Pending])
  assert.deepEqual(await ids(U.empOwnerA), [ATT.a1Active, ATT.a2Pending, ATT.a1Completed, id(304)].sort())
  assert.deepEqual(await ids(U.empOwnerB), [ATT.b1Completed])
  assert.deepEqual(await ids(U.instA), [ATT.a1Active, ATT.a2Pending, ATT.a1Completed, id(304)].sort())
  assert.deepEqual(await ids(U.instB), [ATT.b1Completed])
  assert.deepEqual(await ids(U.stranger), [])
  assert.deepEqual(await ids(U.metaAdmin), [])
  assert.equal((await ids(U.admin)).length, 5)
})

// ---------------- update: PUT /:id ----------------
test('PUT - student cannot complete or certify their own placement (403, no write)', async () => {
  const before = snapshot()
  const r = await call(U.studentA1, 'PUT', `/${ATT.a1Active}`, { status: 'completed', certificate_issued: true })
  assert.equal(r.status, 403)
  assert.equal(snapshot(), before)
})

test('PUT - employer cannot edit placement fields in this pass (403)', async () => {
  for (const u of [U.empOwnerA, U.empTeamA]) {
    assert.equal((await call(u, 'PUT', `/${ATT.a1Active}`, { department: 'Hacked' })).status, 403, u)
  }
  assert.equal(att(ATT.a1Active)!.department, 'ICT')
})

test('PUT - other institution gets 404 and nothing changes', async () => {
  const before = snapshot()
  assert.equal((await call(U.instB, 'PUT', `/${ATT.a1Active}`, { status: 'completed' })).status, 404)
  assert.equal(snapshot(), before)
})

test('PUT - institution lifecycle: pending->active, active->completed(+certificate), ->terminated', async () => {
  let r = await call(U.instA, 'PUT', `/${ATT.a2Pending}`, { status: 'active' })
  assert.equal(r.status, 200); assert.equal(att(ATT.a2Pending)!.status, 'active')
  r = await call(U.instA, 'PUT', `/${ATT.a1Active}`, { status: 'completed', certificate_issued: true })
  assert.equal(r.status, 200)
  assert.equal(att(ATT.a1Active)!.status, 'completed'); assert.equal(att(ATT.a1Active)!.certificate_issued, true)
  r = await call(U.instA, 'PUT', `/${ATT.a2Pending}`, { status: 'terminated' })
  assert.equal(r.status, 200); assert.equal(att(ATT.a2Pending)!.status, 'terminated')
})

test('PUT - pending->terminated allowed; platform admin can transition', async () => {
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a2Pending}`, { status: 'terminated' })).status, 200)
  seed()
  assert.equal((await call(U.admin, 'PUT', `/${ATT.a2Pending}`, { status: 'active' })).status, 200)
})

test('PUT - illegal transitions are 409 and change nothing', async () => {
  const cases: Array<[string, string]> = [
    [ATT.a1Active, 'active'], [ATT.a2Pending, 'completed'],
    [ATT.a1Completed, 'active'], [ATT.a1Completed, 'terminated'], [ATT.a1Completed, 'completed'],
  ]
  for (const [aid, to] of cases) {
    const before = snapshot()
    assert.equal((await call(U.instA, 'PUT', `/${aid}`, { status: to })).status, 409, `${aid} -> ${to}`)
    assert.equal(snapshot(), before)
  }
  // 'pending' is never a target
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { status: 'pending' })).status, 400)
})

test('PUT - protected/ownership fields are rejected (400) and never written', async () => {
  const protectedBodies = [
    { student_id: U.studentB1 }, { university_id: IB }, { employer_id: EB },
    { evaluation_score: 100 }, { certificate_url: 'https://evil.example/cert.pdf' },
    { id: id(555) }, { created_at: '2020-01-01' }, { status: 'active', university_id: IB },
  ]
  for (const b of protectedBodies) {
    const before = snapshot()
    const r = await call(U.instA, 'PUT', `/${ATT.a2Pending}`, b)
    assert.equal(r.status, 400, JSON.stringify(b))
    assert.equal(snapshot(), before)
  }
})

test('PUT - certificate_issued only with status completed; empty body rejected', async () => {
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { certificate_issued: true })).status, 400)
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { certificate_issued: false, status: 'completed' })).status, 400)
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, {})).status, 400)
})

test('PUT - details editable only while pending/active; date order enforced', async () => {
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { department: 'Finance', supervisor_email: '' })).status, 200)
  assert.equal(att(ATT.a1Active)!.department, 'Finance')
  assert.equal(att(ATT.a1Active)!.supervisor_email, null)
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Completed}`, { department: 'X' })).status, 409)
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { end_date: '2026-08-01' })).status, 400)
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { start_date: '2026-02-30' })).status, 400)
  assert.equal((await call(U.instA, 'PUT', `/${ATT.a1Active}`, { supervisor_email: 'not-an-email' })).status, 400)
})

// ---------------- delete ----------------
test('DELETE - student/employer 403, other institution 404', async () => {
  assert.equal((await call(U.studentA2, 'DELETE', `/${ATT.a2Pending}`)).status, 403)
  assert.equal((await call(U.empOwnerA, 'DELETE', `/${ATT.a2Pending}`)).status, 403)
  assert.equal((await call(U.instB, 'DELETE', `/${ATT.a2Pending}`)).status, 404)
  assert.ok(att(ATT.a2Pending))
})

test('DELETE - only pending with no history; otherwise 409 (use terminated)', async () => {
  assert.equal((await call(U.instA, 'DELETE', `/${ATT.a1Active}`)).status, 409)
  assert.equal((await call(U.instA, 'DELETE', `/${ATT.a1Completed}`)).status, 409)
  logbook.push({ id: id(600), attachment_id: ATT.a2Pending })
  assert.equal((await call(U.instA, 'DELETE', `/${ATT.a2Pending}`)).status, 409)
  logbook = []
  const r = await call(U.instA, 'DELETE', `/${ATT.a2Pending}`)
  assert.equal(r.status, 200); assert.equal(att(ATT.a2Pending), undefined)
})

// ---------------- logbook ----------------
const entry = { entry_date: '2026-11-20', week_number: 12, tasks_completed: 'Built a report', skills_learned: '', challenges_faced: null, hours_worked: 8 }

test('logbook POST - own active placement succeeds with server-set attachment_id', async () => {
  const r = await call(U.studentA1, 'POST', `/${ATT.a1Active}/logbook`, entry)
  assert.equal(r.status, 201)
  assert.equal(logbook.length, 1)
  assert.equal(logbook[0].attachment_id, ATT.a1Active)
  assert.equal(logbook[0].skills_learned, null)
  assert.deepEqual(Object.keys(logbook[0]).sort(),
    ['attachment_id', 'challenges_faced', 'entry_date', 'hours_worked', 'id', 'skills_learned', 'tasks_completed', 'week_number'])
})

test('logbook POST - cross-user 404; employer/institution/admin cannot write as the student (403)', async () => {
  assert.equal((await call(U.studentA2, 'POST', `/${ATT.a1Active}/logbook`, entry)).status, 404)
  assert.equal((await call(U.studentB1, 'POST', `/${ATT.a1Active}/logbook`, entry)).status, 404)
  for (const u of [U.empOwnerA, U.empTeamA, U.instA, U.admin]) {
    assert.equal((await call(u, 'POST', `/${ATT.a1Active}/logbook`, entry)).status, 403, u)
  }
  assert.equal(logbook.length, 0)
})

test('logbook POST - only on active placements (409)', async () => {
  assert.equal((await call(U.studentA1, 'POST', `/${ATT.a1Completed}/logbook`, entry)).status, 409)
  assert.equal((await call(U.studentA2, 'POST', `/${ATT.a2Pending}/logbook`, entry)).status, 409)
  assert.equal(logbook.length, 0)
})

test('logbook POST - validation: dates, hours, required text, unknown fields', async () => {
  const bad = [
    { ...entry, entry_date: '2026-11-26' },            // future (today = 2026-11-25)
    { ...entry, entry_date: '2026-08-31' },            // before start_date
    { ...entry, entry_date: '25/11/2026' },            // wrong format
    { ...entry, hours_worked: 25 },
    { ...entry, hours_worked: -1 },
    { ...entry, week_number: 0 },
    { ...entry, tasks_completed: '   ' },
    { ...entry, tasks_completed: 'x'.repeat(5001) },
    { ...entry, attachment_id: ATT.b1Completed },      // ownership id in body
    { ...entry, student_id: U.studentB1 },
  ]
  for (const b of bad) assert.equal((await call(U.studentA1, 'POST', `/${ATT.a1Active}/logbook`, b)).status, 400, JSON.stringify(b).slice(0, 80))
  assert.equal(logbook.length, 0)
})

test('logbook POST - hours_worked must be a whole number (live column is INTEGER)', async () => {
  const bad = await call(U.studentA1, 'POST', `/${ATT.a1Active}/logbook`, { ...entry, hours_worked: 7.5 })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, 'Invalid request body')
  assert.equal(bad.body.details[0].field, 'hours_worked')
  assert.ok(!bad.raw.includes('7.5'), 'submitted value must not be echoed')
  assert.equal(logbook.length, 0)
  const ok = await call(U.studentA1, 'POST', `/${ATT.a1Active}/logbook`, { ...entry, hours_worked: 7 })
  assert.equal(ok.status, 201)
  assert.equal(logbook.length, 1)
  assert.equal(logbook[0].hours_worked, 7)
})

test('logbook GET - related parties read; others 404', async () => {
  logbook.push({ id: id(601), attachment_id: ATT.a1Active, entry_date: '2026-10-01' })
  for (const u of [U.studentA1, U.empTeamA, U.empViewerA, U.instA, U.admin]) {
    assert.equal((await call(u, 'GET', `/${ATT.a1Active}/logbook`)).body.data.length, 1, u)
  }
  for (const u of [U.studentA2, U.empOwnerB, U.instB, U.stranger]) {
    assert.equal((await call(u, 'GET', `/${ATT.a1Active}/logbook`)).status, 404, u)
  }
})

// ---------------- evaluation ----------------
const evalBody = { punctuality_score: 8, teamwork_score: 9, communication_score: 7, technical_skills_score: 8, initiative_score: null,
  overall_score: 82, strengths: 'Reliable', areas_for_improvement: '', recommendation: 'recommend' }

test('evaluation POST - assigned employer on completed placement; employer_id from DB; score synced', async () => {
  const r = await call(U.empOwnerA, 'POST', `/${ATT.a1Completed}/evaluation`, evalBody)
  assert.equal(r.status, 201)
  assert.equal(evaluations.length, 1)
  assert.equal(evaluations[0].employer_id, EA)
  assert.equal(evaluations[0].attachment_id, ATT.a1Completed)
  assert.equal(att(ATT.a1Completed)!.evaluation_score, 82)
})

test('evaluation POST - body cannot override employer_id / attachment_id (400, no write)', async () => {
  for (const extra of [{ employer_id: EB }, { attachment_id: ATT.b1Completed }, { evaluation_score: 100 }]) {
    const r = await call(U.empOwnerA, 'POST', `/${ATT.a1Completed}/evaluation`, { ...evalBody, ...extra })
    assert.equal(r.status, 400, JSON.stringify(extra))
  }
  assert.equal(evaluations.length, 0)
  assert.equal(att(ATT.a1Completed)!.evaluation_score, null)
})

test('evaluation POST - other employer 404; student/institution/admin/viewer 403', async () => {
  assert.equal((await call(U.empOwnerB, 'POST', `/${ATT.a1Completed}/evaluation`, evalBody)).status, 404)
  assert.equal((await call(U.stranger, 'POST', `/${ATT.a1Completed}/evaluation`, evalBody)).status, 404)
  for (const u of [U.studentA1, U.instA, U.admin, U.empViewerA]) {
    assert.equal((await call(u, 'POST', `/${ATT.a1Completed}/evaluation`, evalBody)).status, 403, u)
  }
  assert.equal(evaluations.length, 0)
})

test('evaluation POST - only completed (409); only once (409); team supervisor may evaluate', async () => {
  assert.equal((await call(U.empOwnerA, 'POST', `/${ATT.a1Active}/evaluation`, evalBody)).status, 409)
  assert.equal((await call(U.empOwnerA, 'POST', `/${ATT.a2Pending}/evaluation`, evalBody)).status, 409)
  assert.equal((await call(U.empTeamA, 'POST', `/${ATT.a1Completed}/evaluation`, evalBody)).status, 201)
  assert.equal((await call(U.empOwnerA, 'POST', `/${ATT.a1Completed}/evaluation`, evalBody)).status, 409)
  assert.equal(evaluations.length, 1)
})

test('evaluation POST - score validation', async () => {
  for (const b of [{ ...evalBody, overall_score: 101 }, { ...evalBody, overall_score: -1 }, { ...evalBody, overall_score: undefined },
    { ...evalBody, teamwork_score: 11 }, { ...evalBody, teamwork_score: 7.5 }, { ...evalBody, recommendation: 'hire_now' }]) {
    assert.equal((await call(U.empOwnerA, 'POST', `/${ATT.a1Completed}/evaluation`, b)).status, 400, JSON.stringify(b).slice(0, 60))
  }
  assert.equal(evaluations.length, 0)
})

test('evaluation GET - related parties only', async () => {
  evaluations.push({ id: id(602), attachment_id: ATT.a1Completed, employer_id: EA, overall_score: 70 })
  for (const u of [U.studentA1, U.empOwnerA, U.instA, U.admin]) {
    assert.equal((await call(u, 'GET', `/${ATT.a1Completed}/evaluation`)).body.data.overall_score, 70, u)
  }
  for (const u of [U.studentA2, U.empOwnerB, U.instB]) {
    assert.equal((await call(u, 'GET', `/${ATT.a1Completed}/evaluation`)).status, 404, u)
  }
})

// ---------------- create ----------------
const newPlacement = { student_id: U.studentA3Fresh, employer_id: EA, department: '', supervisor_name: 'Jane',
  supervisor_email: '', supervisor_phone: '', start_date: '2027-01-10', end_date: '2027-04-10' }

test('POST / - institution creates a PENDING placement bound to its own institution', async () => {
  const r = await call(U.instA, 'POST', '/', newPlacement)
  assert.equal(r.status, 201)
  const created = attachments[attachments.length - 1]
  assert.equal(created.status, 'pending')
  assert.equal(created.university_id, IA)
  assert.equal(created.department, null)
  assert.equal(created.supervisor_email, null)
})

test('POST / - ownership/status fields in the body are rejected (400)', async () => {
  for (const extra of [{ university_id: IB }, { status: 'active' }, { evaluation_score: 90 }, { certificate_issued: true }]) {
    const n = attachments.length
    assert.equal((await call(U.instA, 'POST', '/', { ...newPlacement, ...extra })).status, 400, JSON.stringify(extra))
    assert.equal(attachments.length, n)
  }
})

test('POST / - cross-tenant student is not eligible (400); unknown employer 400; bad dates 400', async () => {
  assert.equal((await call(U.instA, 'POST', '/', { ...newPlacement, student_id: U.studentB1 })).status, 400)
  assert.equal((await call(U.instA, 'POST', '/', { ...newPlacement, end_date: '2027-01-01' })).status, 400)
  assert.equal((await call(U.instA, 'POST', '/', { ...newPlacement, student_id: 'abc' })).status, 400)
  assert.equal(attachments.length, 5)
})

test('POST / - non-institution callers (incl. pending account, admin) are 403', async () => {
  for (const u of [U.studentA1, U.empOwnerA, U.instPending, U.admin, U.metaAdmin, U.stranger]) {
    assert.equal((await call(u, 'POST', '/', newPlacement)).status, 403, u)
  }
  assert.equal(attachments.length, 5)
})

test('POST / - student eligibility is strict: status, attachment_status, institution (400, no write)', async () => {
  const cases: Array<[string, string]> = [
    [U.studentA4Ineligible, "status != 'eligible'"],
    [U.studentA5Placed, "attachment_status != 'not_placed'"],
    [U.studentB1, 'belongs to another institution'],
    [id(4999), 'not on any eligible list'],
  ]
  for (const [sid, why] of cases) {
    const r = await call(U.instA, 'POST', '/', { ...newPlacement, student_id: sid })
    assert.equal(r.status, 400, why)
    assert.deepEqual(r.body, { error: 'Student is not eligible for attachment at this institution' }, why)
  }
  assert.equal(attachments.length, 5)
})

test('POST / - one open placement per student: existing pending or active -> 409', async () => {
  // studentA1 has an ACTIVE placement; studentA2 has a PENDING one. Both rows are eligible + not_placed.
  for (const sid of [U.studentA1, U.studentA2]) {
    const r = await call(U.instA, 'POST', '/', { ...newPlacement, student_id: sid })
    assert.equal(r.status, 409, sid)
    assert.deepEqual(r.body, { error: 'Student already has a pending or active placement' })
  }
  assert.equal(attachments.length, 5)
  // a student whose only placement is COMPLETED may be placed again
  assert.equal((await call(U.instA, 'POST', '/', { ...newPlacement, student_id: U.studentA6FinishedEarlier })).status, 201)
  // and once that new placement exists, a second create is refused
  assert.equal((await call(U.instA, 'POST', '/', { ...newPlacement, student_id: U.studentA6FinishedEarlier })).status, 409)
})

test('POST / - employer must be approved AND active; every other state -> 400 (same message)', async () => {
  const states: Array<[string, string]> = [
    [id(299), 'nonexistent'],
    [E_PENDING, 'pending'],
    [E_UNDER_REVIEW, 'under_review'],
    [E_REJECTED, 'rejected'],
    [E_INACTIVE, 'approved but is_active = false (suspended/deactivated)'],
    [E_NULL_STATUS, 'verification_status null'],
  ]
  for (const [eid, why] of states) {
    const r = await call(U.instA, 'POST', '/', { ...newPlacement, employer_id: eid })
    assert.equal(r.status, 400, why)
    assert.deepEqual(r.body, { error: 'Employer is not an approved, active employer' }, why)
  }
  assert.equal(attachments.length, 5)
  const ok = await call(U.instA, 'POST', '/', { ...newPlacement, employer_id: EB })
  assert.equal(ok.status, 201, 'approved + active employer (any approved employer, not only local ones)')
})

// ---------------- eligible students ----------------
test('GET /eligible-students - own institution, not_placed only; others 403; ambiguous 409', async () => {
  const a = await call(U.instA, 'GET', '/eligible-students')
  assert.equal(a.status, 200)
  assert.deepEqual(a.body.data.map((s: Row) => s.student_name).sort(), ['A1', 'A2', 'A3', 'A6'])
  const b = await call(U.instB, 'GET', '/eligible-students')
  assert.deepEqual(b.body.data.map((s: Row) => s.student_name), ['B1'])
  for (const u of [U.studentA1, U.empOwnerA, U.instPending, U.admin, U.stranger]) {
    assert.equal((await call(u, 'GET', '/eligible-students')).status, 403, u)
  }
  assert.equal((await call(U.instMulti, 'GET', '/eligible-students')).status, 409)
  // query params cannot pick another institution
  const spoof = await call(U.instA, 'GET', `/eligible-students?institution_id=${IB}`)
  assert.deepEqual(spoof.body.data.map((s: Row) => s.student_name).sort(), ['A1', 'A2', 'A3', 'A6'])
})

// ---------------- errors ----------------
test('store failures return a generic 500 without leaking DB details', async () => {
  failNextQuery = true
  const r = await call(U.studentA1, 'GET', `/${ATT.a1Active}`)
  assert.equal(r.status, 500)
  assert.deepEqual(r.body, { error: 'Server error' })
  assert.ok(!r.raw.includes('secret_internal_table'))
})

test('validation errors name fields but never echo submitted values', async () => {
  const r = await call(U.instA, 'PUT', `/${ATT.a1Active}`, { certificate_url: 'https://evil.example/x' })
  assert.equal(r.status, 400)
  assert.ok(!r.raw.includes('evil.example'))
})

// ---------------- actor resolution ----------------
test('resolveActor - owner wins over team role; institutions de-duplicated; DB-only inputs', async () => {
  const a = await resolveActor({
    ownedEmployerIds: async () => [EA],
    activeTeamMemberships: async () => [{ employerId: EA, role: 'viewer' }, { employerId: EB, role: 'manager' }],
    activeInstitutionIds: async () => [IA, IA],
    isPlatformAdmin: async () => false,
  }, { id: U.stranger, email: null })
  assert.deepEqual(a.employers.find((m: any) => m.employerId === EA), { employerId: EA, role: 'owner' })
  assert.deepEqual(a.employers.find((m: any) => m.employerId === EB), { employerId: EB, role: 'manager' })
  assert.deepEqual(a.institutionIds, [IA])
})
