import { Router } from "express";
import { createClient } from "@supabase/supabase-js";

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Create campaign -> uses sponsor_ads
router.post("/campaigns", async (req, res) => {
  try {
    const { advertiser_id, name, description, cta_url, image_url, placement, duration_days } = req.body;
    const { data, error } = await supabase.from("sponsor_ads").insert({
      sponsor_id: advertiser_id,
      title: name,
      description: description || "",
      image_url,
      link_url: cta_url,
      status: "pending",
      start_date: new Date().toISOString(),
      end_date: new Date(Date.now() + duration_days * 24 * 60 * 60 * 1000).toISOString(),
      placement: placement?.[0] || "homepage",
    }).select().single();

    if (error) throw error;
    res.status(201).json({ success: true, campaign: data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get campaigns
router.get("/campaigns", async (req, res) => {
  try {
    const { advertiser_id } = req.query;
    const { data, error } = await supabase.from("sponsor_ads").select("*").eq("sponsor_id", advertiser_id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get active ads
router.get("/active", async (req, res) => {
  try {
    const { data, error } = await supabase.from("sponsor_ads").select("*").eq("status", "active").lte("start_date", new Date().toISOString()).gte("end_date", new Date().toISOString());
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Track impression
router.post("/impression", async (req, res) => {
  try {
    await supabase.from("ad_impressions").insert({ ad_id: req.body.campaign_id });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Track click
router.post("/click", async (req, res) => {
  try {
    await supabase.from("campaign_clicks").insert({ campaign_id: req.body.campaign_id, ip_address: req.body.ip_address, user_agent: req.body.user_agent });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get campaign analytics
router.get("/campaigns/:id/analytics", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: campaign } = await supabase.from("sponsor_ads").select("id, title, status, start_date, end_date").eq("id", id).single();
    const { count: impressions } = await supabase.from("ad_impressions").select("*", { count: "exact", head: true }).eq("ad_id", id);
    const { count: clicks } = await supabase.from("campaign_clicks").select("*", { count: "exact", head: true }).eq("campaign_id", id);
    const { data: clickTimeline } = await supabase.from("campaign_clicks").select("created_at").eq("campaign_id", id).order("created_at", { ascending: true });
    const totalImpressions = impressions || 0;
    const totalClicks = clicks || 0;
    const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0";
    res.json({ campaign, analytics: { impressions: totalImpressions, clicks: totalClicks, ctr: parseFloat(ctr) }, clickTimeline: clickTimeline || [] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
