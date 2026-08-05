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

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key']
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  
  next()
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  const adminKey = req.headers['x-admin-key']
  
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  
  next()
}
