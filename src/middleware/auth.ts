import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

// Accepts either the shared admin key (x-admin-key, what the admin dashboard
// sends) or a Supabase JWT belonging to an admin. Always answers 401 on
// failure so a caller can't tell "no credentials" from "wrong role".
//
// Admin-ness is read from admin_users / user_roles / user_metadata only -
// deliberately NOT from users.role, because PATCH /api/auth/users/:id/role
// writes that column. Trusting it here would let one bad write mint admins.
//
// Note: admin_users and user_roles are both empty in production today, so in
// practice the x-admin-key branch is the only one that grants access. The JWT
// branch is here for when those tables get populated.
/**
 * adminAuth — async admin authentication
 * Used by: every admin-gated route in the app (unified onto this single
 *   function as of Cycle 005 - previously split between this and the now-
 *   removed adminMiddleware, which only accepted x-admin-key with no JWT path).
 * Checks: EITHER the shared x-admin-key header matching process.env.ADMIN_KEY,
 *   OR a Bearer Supabase JWT belonging to a user whose role - read from
 *   admin_users (by email, if is_active !== false), then user_roles (by
 *   user_id), then user_metadata.role, in that priority order - is 'admin' or
 *   'super_admin'. The JWT lookup is race-timed against an 8s timeout so a
 *   hung Supabase auth call can't hang the request. admin_users/user_roles
 *   are both empty in production today, so in practice only the x-admin-key
 *   branch currently grants access - the JWT branch exists for when those
 *   tables get populated.
 * Returns: 401 Unauthorized on any failure (missing/wrong key, invalid JWT,
 *   valid JWT but no admin/super_admin role, or an unexpected error - all
 *   collapse to the same 401 so a caller can't distinguish "no credentials"
 *   from "wrong role").
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-admin-key']
  const expected = process.env.ADMIN_KEY

  if (expected && typeof provided === 'string' && provided === expected) {
    return next()
  }

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // Timeout-race so a slow/hung Supabase auth API can't hang this request
    // forever - falls into the same catch below, preserving the "always 401
    // on failure" invariant above (no distinguishable timeout status).
    const authResult = await Promise.race([
      supabase.auth.getUser(authHeader.slice(7)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Auth service timeout')), 8000))
    ])
    const { data: { user }, error } = authResult as any
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' })

    // admin_users has no user_id column - its PK is its own uuid and the
    // correlation key to an auth user is the UNIQUE email. user_roles does key
    // on user_id.
    const [adminRow, roleRow] = await Promise.all([
      user.email
        ? supabase.from('admin_users').select('role, is_active').eq('email', user.email).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('user_roles').select('role').eq('user_id', user.id).maybeSingle(),
    ])

    const adminUser = adminRow.data as { role?: string; is_active?: boolean } | null
    const role =
      (adminUser && adminUser.is_active !== false ? adminUser.role : undefined) ||
      roleRow.data?.role ||
      user.user_metadata?.role
    if (role === 'admin' || role === 'super_admin') return next()

    return res.status(401).json({ error: 'Unauthorized' })
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// Narrow, CI-only sibling of adminAuth's x-admin-key check - accepts EITHER
// the shared ADMIN_KEY or the scoped TVETA_SCRAPER_KEY. Deliberately does NOT
// fall into the JWT/admin-role path adminAuth has, and is used standalone
// (not via adminAuth) so TVETA_SCRAPER_KEY only unlocks POST /api/tveta/run -
// not the ~130 other routes gated by adminAuth (Paystack disbursements, user
// role/delete, institutions, etc). Adding TVETA_SCRAPER_KEY to adminAuth
// itself would turn it into a second full admin master key, defeating the
// point of a scoped CI credential.
export function tvetaScraperAuth(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-admin-key']
  const valid = [process.env.ADMIN_KEY, process.env.TVETA_SCRAPER_KEY].filter(Boolean)

  if (typeof provided === 'string' && valid.includes(provided)) {
    return next()
  }

  return res.status(401).json({ error: 'Unauthorized' })
}

// Same pattern as tvetaScraperAuth above, scoped to the university scraper
// cron job instead. Accepts ADMIN_KEY or UNIVERSITY_SCRAPER_KEY. Used
// standalone on POST /api/admin/scraper/run and GET /api/admin/scraper/sources
// only - not on the rest of /api/admin/scraper/* (jobs, changes, approve/
// reject, POST /sources), which stay behind the full adminAuth.
export function universityScraperAuth(req: Request, res: Response, next: NextFunction) {
  const provided = req.headers['x-admin-key']
  const valid = [process.env.ADMIN_KEY, process.env.UNIVERSITY_SCRAPER_KEY].filter(Boolean)

  if (typeof provided === 'string' && valid.includes(provided)) {
    return next()
  }

  return res.status(401).json({ error: 'Unauthorized' })
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key']
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  
  next()
}

// REMOVED: adminMiddleware deprecated. All admin routes now use adminAuth.
