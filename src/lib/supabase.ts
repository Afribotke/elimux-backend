import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || ''
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// Guards against the failure that took payments down on 2026-07-30: the anon
// key was pasted into SUPABASE_SERVICE_ROLE_KEY. createClient() accepts any
// string, so the only symptom was every write to an RLS-protected table
// (subscribers, subscriptions, payments) failing at runtime with
// "new row violates row-level security policy".
//
// Deliberately does NOT exit on a *wrong* key: reads on publicly-policied
// tables (programs, institutions, search) work fine with one, so killing the
// process would turn a payments outage into a total one. A *missing* key is
// different — createClient() itself throws on an empty string, so the process
// dies at import regardless. The log below still lands first either way.
type KeyRole = 'service_role' | 'anon' | 'unknown' | 'missing'

function detectKeyRole(key: string): KeyRole {
  if (!key) return 'missing'

  // Supabase's newer non-JWT API keys are opaque, so the prefix is the only
  // signal available.
  if (key.startsWith('sb_secret_')) return 'service_role'
  if (key.startsWith('sb_publishable_')) return 'anon'

  // Legacy JWT keys carry the role in the payload.
  const segments = key.split('.')
  if (segments.length !== 3) return 'unknown'

  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
    if (payload.role === 'service_role') return 'service_role'
    if (payload.role === 'anon') return 'anon'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export const supabaseKeyRole = detectKeyRole(supabaseServiceKey)
export const supabaseConfigOk = Boolean(supabaseUrl) && supabaseKeyRole === 'service_role'

if (!supabaseUrl) {
  console.error('[supabase] SUPABASE_URL is not set — all database calls will fail.')
}

if (supabaseKeyRole !== 'service_role') {
  const detail =
    supabaseKeyRole === 'missing'
      ? 'the variable is empty'
      : supabaseKeyRole === 'anon'
        ? 'it holds an ANON key, which RLS will block on every protected write'
        : 'its role could not be determined'

  console.error(
    `[supabase] SUPABASE_SERVICE_ROLE_KEY is not a service_role key — ${detail}. ` +
      'Payments, subscriptions and other RLS-protected writes WILL fail. ' +
      'Copy the service_role secret from Supabase Dashboard -> Project Settings -> API. ' +
      `Detected role: ${supabaseKeyRole}. See GET /health for current status.`
  )
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey)
