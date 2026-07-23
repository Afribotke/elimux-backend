import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const COMMISSION_RATE = 0.15;

// Track referral click -> uses partner_clicks
router.post("/track", async (req, res) => {
  try {
    const { referral_code, ip_address, user_agent } = req.body;
    const { data: partner } = await supabase.from("partner_clients").select("id").eq("referral_code", referral_code).single();
    if (!partner) return res.status(404).json({ error: "Invalid referral code" });

    const { data, error } = await supabase.from("partner_clicks").insert({
      partner_id: partner.id,
      ip_address: ip_address || null,
      user_agent: user_agent || null,
      converted: false,
    }).select().single();

    if (error) throw error;
    res.status(201).json({ success: true, click: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Convert referral
router.post("/convert", async (req, res) => {
  try {
    const { click_id, amount, description } = req.body;
    const { data: click } = await supabase.from("partner_clicks").select("*, partner_clients(id, commission_rate)").eq("id", click_id).single();
    if (!click) return res.status(404).json({ error: "Click not found" });

    const commissionAmount = amount * (click.partner_clients?.commission_rate || COMMISSION_RATE);

    await supabase.from("partner_clicks").update({ converted: true, converted_at: new Date().toISOString() }).eq("id", click_id);

    const { data: commission } = await supabase.from("partner_commissions").insert({
      partner_id: click.partner_id,
      amount: commissionAmount,
      status: "pending",
      description: description || "Referral commission",
      holding_period_days: 30,
    }).select().single();

    res.json({ success: true, commission });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get clicks for partner
router.get("/", async (req, res) => {
  try {
    const { partner_user_id } = req.query;
    const { data: partner } = await supabase.from("partner_clients").select("id").eq("user_id", partner_user_id).single();
    if (!partner) return res.status(404).json({ error: "Partner not found" });

    const { data, error } = await supabase.from("partner_clicks").select("*").eq("partner_id", partner.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get commissions for partner
router.get("/commissions", async (req, res) => {
  try {
    const { partner_user_id } = req.query;
    const { data: partner } = await supabase.from("partner_clients").select("id").eq("user_id", partner_user_id).single();
    if (!partner) return res.status(404).json({ error: "Partner not found" });

    const { data, error } = await supabase.from("partner_commissions").select("*").eq("partner_id", partner.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
