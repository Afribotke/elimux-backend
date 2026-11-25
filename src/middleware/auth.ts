import { Request, Response, NextFunction } from 'express'
// Shared service-role client (same SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// env vars as before). Using the shared instance instead of a private one
// lets tests stub it.
import { supabase } from '../lib/supabase'

// Roles in admin_users / user_roles that count as platform admin. Unchanged
// from the previous inline check - do not widen without review.
const DB_ADMIN_ROLES = ['admin', 'super_admin']

/**
 * decideDbAdmin - pure decision step, exported for tests.
 * 1. If an ACTIVE admin_users row exists, its role alone decides (unchanged
 *    priority: an active admin_users row with a non-admin role is NOT
 *    rescued by user_roles).
 * 2. Otherwise, admin iff ANY user_roles row for the user has an admin role.
 *    (Previously .maybeSingle() errored on 2+ rows and silently denied, e.g.
 *    a user holding both nita_admin and admin. The accepted role set is
 *    unchanged, so this cannot admit anyone without an admin/super_admin row.)
 * user_metadata and users.role are NEVER consulted: metadata is writable by
 * the user (supabase.auth.updateUser with the anon key) and users.role's
 * write protection is unverified.
 */
export function decideDbAdmin(
  adminUser: { role?: string; is_active?: boolean } | null | undefined,
  roleRows: Array<{ role?: string | null }> | null | undefined
): boolean {
  if (adminUser && adminUser.is_active !== false && adminUser.role) {
    return DB_ADMIN_ROLES.includes(adminUser.role)
  }
  return (roleRows ?? []).some(r => typeof r?.role === 'string' && DB_ADMIN_ROLES.includes(r.role))
}

/**
 * hasDbAdminRole - DB-backed platform-admin check for an already-verified
 * Supabase user (caller must have obtained `user` from auth.getUser(token)).
 * Reads only admin_users (by email) and user_roles (by user_id). Any query
 * error fails closed.
 */
export async function hasDbAdminRole(user: { id: string; email?: string | null }): Promise<boolean> {
  // admin_users has no user_id column - its PK is its own uuid and the
  // correlation key to an auth user is the UNIQUE email. user_roles does key
  // on user_id and may hold several rows per user.
  const [adminRes, rolesRes] = await Promise.all([
    user.email
      ? supabase.from('admin_users').select('role, is_active').eq('email', user.email).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('user_roles').select('role').eq('user_id', user.id),
  ])
  if ((adminRes as any).error || (rolesRes as any).error) return false
  return decideDbAdmin(
    adminRes.data as { role?: string; is_active?: boolean } | null,
    rolesRes.data as Array<{ role?: string | null }> | null
  )
}

// Accepts either the shared admin key (x-admin-key, what the admin dashboard
// sends) or a Supabase JWT belonging to an admin. Always answers 401 on
// failure so a caller can't tell "no credentials" from "wrong role".
//
// Admin-ness is read from admin_users / user_roles only - deliberately NOT
// from users.role (PATCH /api/auth/users/:id/role writes that column) and
// NOT from user_metadata (user-writable). See hasDbAdminRole above.
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
 *   user_id), in that priority order - is 'admin' or 'super_admin'.
 *   user_metadata.role is NOT consulted (user-writable; removed in the
 *   admin-trust hotfix). The JWT lookup is race-timed against an 8s timeout so a
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

    if (await hasDbAdminRole(user)) return next()

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
