import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { adminAuth } from "../middleware/auth";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Mirrors UserRole in ../middleware/rbac. The endpoint used to write whatever
// string the caller sent, so an allowlist goes in alongside the auth gate.
const ASSIGNABLE_ROLES = ["student", "partner", "advertiser", "institution", "admin", "super_admin"];

// Get current user with role
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });

    const { data: { user }, error } = await supabase.auth.getUser(authHeader.split(" ")[1]);
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

// List all users - admin only
router.get("/users", adminAuth, async (req, res) => {
  try {
    // Two queries rather than a `users -> admin_users` embed: there is no FK
    // between those tables, so PostgREST rejects the embed with a schema-cache
    // error and this endpoint 500'd on every call, credentials or not.
    // The two tables correlate on email, not on any id column.
    const [usersRes, adminsRes] = await Promise.all([
      supabase.from("users").select("*").order("created_at", { ascending: false }),
      supabase.from("admin_users").select("email, role, is_active"),
    ]);
    if (usersRes.error) throw usersRes.error;
    if (adminsRes.error) throw adminsRes.error;

    const adminByEmail = new Map(
      (adminsRes.data || []).map((a: any) => [String(a.email || "").toLowerCase(), a])
    );
    // Keep the original response shape - admin_users as an embed-style array.
    const data = (usersRes.data || []).map((u: any) => {
      const admin = adminByEmail.get(String(u.email || "").toLowerCase());
      return {
        ...u,
        admin_users: admin ? [{ role: admin.role, is_active: admin.is_active }] : [],
      };
    });
    res.json(data);
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

export default router;
