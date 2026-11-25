// Focused tests for the admin-trust hotfix. No network, no real keys:
// the shared Supabase client is stubbed in-process. Run with `npm test`.
//
// Dummy env MUST be set before the middleware modules are imported, because
// they create their Supabase clients at import time.
process.env.SUPABASE_URL = 'http://127.0.0.1:9' // discard port, never a real project
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_dummy_for_unit_tests_only'
process.env.ADMIN_KEY = 'test-admin-key-not-a-real-secret'

import { test } from 'node:test'
import assert from 'node:assert/strict'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { supabase } = require('../src/lib/supabase')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { adminAuth, decideDbAdmin, hasDbAdminRole } = require('../src/middleware/auth')

type Rows = { admin_users?: any; user_roles?: any }

function stub(user: any, rows: Rows = {}) {
  const calls: string[] = []
  supabase.auth.getUser = async () => ({ data: { user }, error: user ? null : new Error('bad token') })
  supabase.from = (table: string) => {
    calls.push(table)
    const value = (rows as any)[table] ?? null
    const q: any = {
      select: () => q,
      eq: () => q,
      // single-row read (admin_users by unique email)
      maybeSingle: async () => ({ data: Array.isArray(value) ? value[0] ?? null : value, error: null }),
      // list read (user_roles by user_id): awaiting the builder yields an array
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: value === null ? [] : Array.isArray(value) ? value : [value], error: null }).then(resolve, reject),
    }
    return q
  }
  return calls
}

async function run(headers: Record<string, string>) {
  let nextCalled = false
  let status = 200
  const req: any = { headers }
  const res: any = { status(s: number) { status = s; return this }, json() { return this } }
  await adminAuth(req, res, () => { nextCalled = true })
  return { nextCalled, status }
}

const bearer = { authorization: 'Bearer fake.jwt.token' }

test('user_metadata.role=admin with no DB rows is refused', async () => {
  stub({ id: 'u1', email: 'x@example.com', user_metadata: { role: 'admin' } })
  assert.deepEqual(await run(bearer), { nextCalled: false, status: 401 })
})

test('user_metadata.role=super_admin with no DB rows is refused', async () => {
  stub({ id: 'u1', email: 'x@example.com', user_metadata: { role: 'super_admin' } })
  assert.deepEqual(await run(bearer), { nextCalled: false, status: 401 })
})

test('user_roles admin row grants access', async () => {
  stub({ id: 'u2', email: 'a@example.com', user_metadata: {} }, { user_roles: { role: 'admin' } })
  assert.deepEqual(await run(bearer), { nextCalled: true, status: 200 })
})

test('active admin_users row grants access', async () => {
  stub({ id: 'u3', email: 'b@example.com' }, { admin_users: { role: 'super_admin', is_active: true } })
  assert.deepEqual(await run(bearer), { nextCalled: true, status: 200 })
})

test('inactive admin_users row is refused (metadata admin does not rescue it)', async () => {
  stub({ id: 'u4', email: 'c@example.com', user_metadata: { role: 'admin' } }, { admin_users: { role: 'admin', is_active: false } })
  assert.deepEqual(await run(bearer), { nextCalled: false, status: 401 })
})

test('non-admin DB roles (elimux_admin, nita_admin) are not widened into adminAuth', async () => {
  stub({ id: 'u5', email: 'd@example.com' }, { user_roles: { role: 'elimux_admin' } })
  assert.equal((await run(bearer)).nextCalled, false)
  stub({ id: 'u5', email: 'd@example.com' }, { user_roles: { role: 'nita_admin' } })
  assert.equal((await run(bearer)).nextCalled, false)
})

test('invalid JWT is refused', async () => {
  stub(null)
  assert.deepEqual(await run(bearer), { nextCalled: false, status: 401 })
})

test('x-admin-key path unchanged: correct key passes without any DB lookup', async () => {
  const calls = stub(null)
  assert.deepEqual(await run({ 'x-admin-key': 'test-admin-key-not-a-real-secret' }), { nextCalled: true, status: 200 })
  assert.deepEqual(calls, [])
})

test('x-admin-key path unchanged: wrong key and no bearer is refused', async () => {
  stub(null)
  assert.deepEqual(await run({ 'x-admin-key': 'wrong' }), { nextCalled: false, status: 401 })
})

test('hasDbAdminRole reads only admin_users and user_roles - never users or metadata', async () => {
  // A users row saying admin must not matter: the stub would return it if queried.
  const calls = stub(null, { users: { role: 'admin' } } as any)
  const ok = await hasDbAdminRole({ id: 'u6', email: 'e@example.com', user_metadata: { role: 'admin' } } as any)
  assert.equal(ok, false)
  assert.deepEqual([...calls].sort(), ['admin_users', 'user_roles'])
})

test('hasDbAdminRole without an email skips admin_users and checks user_roles only', async () => {
  const calls = stub(null, { user_roles: { role: 'super_admin' } })
  assert.equal(await hasDbAdminRole({ id: 'u7' }), true)
  assert.deepEqual(calls, ['user_roles'])
})

test('decideDbAdmin: active admin_users role decides; else any admin user_roles row', () => {
  assert.equal(decideDbAdmin(null, null), false)
  assert.equal(decideDbAdmin(null, []), false)
  assert.equal(decideDbAdmin({ role: 'admin', is_active: false }, null), false)
  assert.equal(decideDbAdmin({ role: 'admin', is_active: false }, [{ role: 'super_admin' }]), true)
  assert.equal(decideDbAdmin({ role: 'admin' }, [{ role: 'user' }]), true)
  // unchanged priority: an ACTIVE admin_users row with a non-admin role is not rescued by user_roles
  assert.equal(decideDbAdmin({ role: 'moderator', is_active: true }, [{ role: 'admin' }]), false)
  // multiple user_roles rows (previously a .maybeSingle() error -> silent deny)
  assert.equal(decideDbAdmin(null, [{ role: 'nita_admin' }, { role: 'admin' }]), true)
  // no widening: multiple non-admin rows stay non-admin
  assert.equal(decideDbAdmin(null, [{ role: 'nita_admin' }, { role: 'elimux_admin' }, { role: 'moderator' }]), false)
  assert.equal(decideDbAdmin(null, [{ role: null }, {}]), false)
})

test('hasDbAdminRole handles multiple user_roles rows without widening', async () => {
  stub(null, { user_roles: [{ role: 'nita_admin' }, { role: 'admin' }] })
  assert.equal(await hasDbAdminRole({ id: 'u8' }), true)
  stub(null, { user_roles: [{ role: 'nita_admin' }, { role: 'elimux_admin' }] })
  assert.equal(await hasDbAdminRole({ id: 'u8' }), false)
})

test('hasDbAdminRole fails closed on a query error', async () => {
  supabase.from = (_t: string) => {
    const q: any = {
      select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: [{ role: 'admin' }], error: { code: 'XX000' } }).then(resolve),
    }
    return q
  }
  assert.equal(await hasDbAdminRole({ id: 'u9', email: 'f@example.com' }), false)
})
