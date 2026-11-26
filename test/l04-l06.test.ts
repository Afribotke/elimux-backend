// L-04: retired legacy logbook routes answer 410 Gone through the REAL
// internships router (no auth, no DB). L-06: the Supabase store adapter maps
// a 23505 unique violation on attachments insert to ConflictError.
// No Supabase, no network, no keys: the DB client is an in-memory stub.
process.env.SUPABASE_URL = 'http://127.0.0.1:9'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_dummy_for_unit_tests_only'

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const internshipsRouter = require('../src/routes/internships').default
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSupabaseAttachmentStore, ConflictError } = require('../src/lib/authz/attachment-store')

let server: Server
let base = ''
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', internshipsRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
after(() => server.close())

const GONE = { success: false, error: 'This endpoint has been retired. Use /api/attachments/:id/logbook.' }

test('L-04: POST /students/logbook -> 410 Gone, with or without credentials', async () => {
  for (const headers of [{}, { authorization: 'Bearer not-a-real-token' }]) {
    const r = await fetch(`${base}/students/logbook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ entry_date: '2026-11-20', tasks_completed: 'x', hours_worked: 8 }),
    })
    assert.equal(r.status, 410)
    assert.deepEqual(await r.json(), GONE)
  }
})

test('L-04: GET /students/me/logbook -> 410 Gone, with or without credentials', async () => {
  for (const headers of [{}, { authorization: 'Bearer not-a-real-token' }]) {
    const r = await fetch(`${base}/students/me/logbook`, { headers })
    assert.equal(r.status, 410)
    assert.deepEqual(await r.json(), GONE)
  }
})

test('L-04: neighbouring student routes are unchanged (still require auth)', async () => {
  const r = await fetch(`${base}/students/me`)
  assert.equal(r.status, 401)
})

// Minimal stub of the supabase-js chain used by insertAttachment:
// from('attachments').insert(row).select(cols).single()
function stubDb(result: { data: unknown; error: unknown }) {
  const calls: string[] = []
  const chain: any = {
    insert: (row: unknown) => { calls.push('insert'); assert.ok(row); return chain },
    select: () => { calls.push('select'); return chain },
    single: async () => { calls.push('single'); return result },
  }
  return { db: { from: (t: string) => { calls.push(`from:${t}`); return chain } }, calls }
}
const row = { student_id: 'a', university_id: 'b', employer_id: 'c', start_date: '2027-01-01', status: 'pending' }

test('L-06: store.insertAttachment maps 23505 -> ConflictError', async () => {
  const { db, calls } = stubDb({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "attachments_one_open_per_student"' } })
  const store = createSupabaseAttachmentStore(db)
  await assert.rejects(store.insertAttachment(row), (e: unknown) => e instanceof ConflictError)
  assert.deepEqual(calls, ['from:attachments', 'insert', 'select', 'single'])
})

test('L-06: other DB errors stay generic (not ConflictError, no DB message leaked)', async () => {
  const { db } = stubDb({ data: null, error: { code: '23503', message: 'insert violates foreign key constraint "secret_fk"' } })
  const store = createSupabaseAttachmentStore(db)
  await assert.rejects(store.insertAttachment(row), (e: any) => {
    assert.ok(!(e instanceof ConflictError))
    assert.doesNotMatch(e.message, /secret_fk/)
    return true
  })
})

test('L-06: success returns the inserted row', async () => {
  const { db } = stubDb({ data: { id: 'x', ...row }, error: null })
  const store = createSupabaseAttachmentStore(db)
  assert.equal((await store.insertAttachment(row)).id, 'x')
})
