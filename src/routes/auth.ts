import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { adminAuth } from "../middleware/auth";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Mirrors UserRole in ../middleware/rbac. The endpoint used to write whatever
// string the caller sent, so an allowlist goes in alongside the auth gate.
const ASSIGNABLE_ROLES = ["student", "partner", "advertiser", "institution", "admin", "super_admin"];

// Real admin panel access is gated on admin_users/user_roles (see
// middleware/auth.ts's adminAuth), not on this users.role column - setting
// role to "admin"/"super_admin" here does not grant admin access. Kept in
// ASSIGNABLE_ROLES since the column itself accepts these values, but the
// admin users page deliberately doesn't offer them to avoid implying this
// endpoint can grant admin access.

const PROTECTED_ADMIN_EMAIL = "admin@elimux.ke";

// No FK constraints exist from any other table to public.users.id (verified
// against the live schema) - Postgres won't stop an orphaning delete on its
// own, so this is an application-level guard.
async function hasAnyRow(table: string, column: string, value: string): Promise<boolean> {
  const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq(column, value);
  return (count ?? 0) > 0;
}

// Get current user with role
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });

    let authResult;
    try {
      authResult = await Promise.race([
        supabase.auth.getUser(authHeader.split(" ")[1]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Auth service timeout")), 8000)
        )
      ]);
    } catch (raceErr: any) {
      if (raceErr?.message === "Auth service timeout") {
        return res.status(503).json({ error: "Authentication service temporarily unavailable. Please try again." });
      }
      throw raceErr;
    }
    const { data: { user }, error } = authResult as any;
    if (error || !user) return res.status(401).json({ error: "Invalid token" });

    // admin_users is keyed by its own uuid PK with email as the UNIQUE
    // correlation key - it has no user_id column, so the old .eq("user_id")
    // lookup always errored and this endpoint silently never saw an admin.
    const [{ data: userData }, { data: adminData }] = await Promise.all([
      supabase.from("users").select("role, full_name").eq("id", user.id).maybeSingle(),
      user.email
        ? supabase.from("admin_users").select("role").eq("email", user.email).maybeSingle()
        : Promise.resolve({ data: null as { role?: string } | null }),
    ]);

    const role = adminData?.role || userData?.role || "user";
    res.json({ user: { id: user.id, email: user.email, role, full_name: userData?.full_name } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// List all users - admin only, paginated
router.get("/users", adminAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || "1"));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "25")));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Two queries rather than a `users -> admin_users` embed: there is no FK
    // between those tables, so PostgREST rejects the embed with a schema-cache
    // error and this endpoint 500'd on every call, credentials or not.
    // The two tables correlate on email, not on any id column.
    const [usersRes, adminsRes] = await Promise.all([
      supabase.from("users").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(from, to),
      supabase.from("admin_users").select("email, role, is_active"),
    ]);
    if (usersRes.error) throw usersRes.error;
    if (adminsRes.error) throw adminsRes.error;

    const adminByEmail = new Map(
      (adminsRes.data || []).map((a: any) => [String(a.email || "").toLowerCase(), a])
    );

    // last_sign_in_at/banned_until live on auth.users, not public.users -
    // fetch per row via the admin API, bounded to this page's size (same
    // pattern as attachments.ts's attachStudentInfo).
    const data = await Promise.all(
      (usersRes.data || []).map(async (u: any) => {
        const admin = adminByEmail.get(String(u.email || "").toLowerCase());
        const authResult = await supabase.auth.admin.getUserById(u.id).catch(() => null);
        const authUser = authResult?.data?.user as any;
        return {
          ...u,
          admin_users: admin ? [{ role: admin.role, is_active: admin.is_active }] : [],
          last_sign_in_at: authUser?.last_sign_in_at ?? null,
          banned_until: authUser?.banned_until ?? null,
        };
      })
    );

    res.json({ data, count: usersRes.count ?? data.length, page, limit });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update user role - admin only
router.patch("/users/:id/role", adminAuth, async (req, res) => {
  try {
    const role = req.body?.role;
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(", ")}` });
    }

    const { data, error } = await supabase.from("users").update({ role, updated_at: new Date().toISOString() }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, user: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Suspend / activate a user - admin only. Toggling public.users.is_active
// alone would have zero real effect - nothing in this app's own auth checks
// that column (verified: only admin_users.is_active and
// employer_team_members.is_active are ever checked). The actual enforcement
// is Supabase Auth's own ban mechanism, which blocks sign-in unconditionally
// regardless of app code. is_active is kept in sync only so the list view
// can show status without an extra call per row.
router.patch("/users/:id/status", adminAuth, async (req, res) => {
  try {
    const id = req.params.id as string;
    const { is_active } = req.body || {};
    if (typeof is_active !== "boolean") {
      return res.status(400).json({ error: "is_active must be a boolean" });
    }

    const { data: target } = await supabase.from("users").select("email").eq("id", id).maybeSingle();
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.email?.toLowerCase() === PROTECTED_ADMIN_EMAIL) {
      return res.status(403).json({ error: `${PROTECTED_ADMIN_EMAIL} cannot be suspended` });
    }

    const { error: authError } = await supabase.auth.admin.updateUserById(id, {
      ban_duration: is_active ? "none" : "87600h", // ~10 years - effectively permanent until reactivated
    });
    if (authError) throw authError;

    const { data, error } = await supabase
      .from("users")
      .update({ is_active, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, user: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a user - admin only. Mirrors the auth-user-cleanup rule from past
// incidents: never touch admin@elimux.ke, and refuse to delete anyone still
// referenced by advertisers, institution_accounts, subscribers (email-only,
// no user_id column), employers (as owner or admin_user_id), or
// employer_team_members - deleting out from under any of those would orphan
// real records rather than cleanly removing an unused account.
router.delete("/users/:id", adminAuth, async (req, res) => {
  try {
    const id = req.params.id as string;
    const { data: target } = await supabase.from("users").select("email").eq("id", id).maybeSingle();
    if (!target) return res.status(404).json({ error: "User not found" });

    const email = (target.email || "").toLowerCase();
    if (email === PROTECTED_ADMIN_EMAIL) {
      return res.status(403).json({ error: `${PROTECTED_ADMIN_EMAIL} cannot be deleted` });
    }

    const [isAdvertiser, isInstitutionAccount, isSubscriber, ownsEmployer, adminsEmployer, isTeamMember, isAdminUser] = await Promise.all([
      hasAnyRow("advertisers", "user_id", id),
      hasAnyRow("institution_accounts", "user_id", id),
      email ? hasAnyRow("subscribers", "email", email) : Promise.resolve(false),
      hasAnyRow("employers", "user_id", id),
      hasAnyRow("employers", "admin_user_id", id),
      hasAnyRow("employer_team_members", "user_id", id),
      email ? hasAnyRow("admin_users", "email", email) : Promise.resolve(false),
    ]);

    const blockers: string[] = [];
    if (isAdvertiser) blockers.push("advertisers");
    if (isInstitutionAccount) blockers.push("institution_accounts");
    if (isSubscriber) blockers.push("subscribers");
    if (ownsEmployer) blockers.push("employers (owner)");
    if (adminsEmployer) blockers.push("employers (admin)");
    if (isTeamMember) blockers.push("employer_team_members");
    if (isAdminUser) blockers.push("admin_users");

    if (blockers.length > 0) {
      return res.status(409).json({
        error: `Cannot delete: this user is referenced in ${blockers.join(", ")}. Remove those associations first.`,
      });
    }

    const { error: authError } = await supabase.auth.admin.deleteUser(id);
    if (authError) throw authError;

    // No FK/cascade from public.users to auth.users - clean up explicitly.
    await supabase.from("users").delete().eq("id", id);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
