import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Register new partner -> uses partner_clients table
router.post("/register", async (req, res) => {
  try {
    const { user_id, full_name, email, phone, company, website } = req.body;

    const { data: codeData } = await supabase.rpc("generate_partner_code");
    const referral_code = codeData || `ELX${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

    const { data, error } = await supabase
      .from("partner_clients")
      .insert({
        user_id,
        full_name,
        email,
        phone,
        company_name: company || null,
        website: website || null,
        referral_code,
        status: "pending",
        total_earnings: 0,
        commission_rate: 0.15,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, partner: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Registration failed" });
  }
});

// Get partner by user ID
router.get("/me", async (req, res) => {
  try {
    const { user_id } = req.query;
    const { data, error } = await supabase
      .from("partner_clients")
      .select("*, partner_commissions(*), partner_payouts(*)")
      .eq("user_id", user_id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Partner not found" });
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get partner stats
router.get("/:id/stats", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: partner, error } = await supabase
      .from("partner_clients")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;

    const [{ data: clicks }, { data: commissions }, { data: payouts }] = await Promise.all([
      supabase.from("partner_clicks").select("*").eq("partner_id", id).order("created_at", { ascending: false }),
      supabase.from("partner_commissions").select("*").eq("partner_id", id).order("created_at", { ascending: false }),
      supabase.from("partner_payouts").select("*").eq("partner_id", id).order("created_at", { ascending: false }),
    ]);

    res.json({ partner, clicks: clicks || [], commissions: commissions || [], payouts: payouts || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Approve partner
router.patch("/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("partner_clients")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, partner: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
