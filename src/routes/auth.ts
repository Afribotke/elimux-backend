import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Get current user with role
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });

    const { data: { user }, error } = await supabase.auth.getUser(authHeader.split(" ")[1]);
    if (error || !user) return res.status(401).json({ error: "Invalid token" });

    const [{ data: userData }, { data: adminData }] = await Promise.all([
      supabase.from("users").select("role, full_name").eq("id", user.id).single(),
      supabase.from("admin_users").select("role").eq("user_id", user.id).single(),
    ]);

    const role = adminData?.role || userData?.role || "user";
    res.json({ user: { id: user.id, email: user.email, role, full_name: userData?.full_name } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// List all users
router.get("/users", async (req, res) => {
  try {
    const { data, error } = await supabase.from("users").select("*, admin_users(role)").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update user role
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { data, error } = await supabase.from("users").update({ role: req.body.role, updated_at: new Date().toISOString() }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, user: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
