import { Router } from "express";
import { adminAuth } from "../middleware/auth";
import { supabase } from "../lib/supabase";

const router = Router();

// List eligible students missing institution_id
router.get("/unassigned", adminAuth, async (req, res) => {
  try {
    const { limit = "50", offset = "0" } = req.query;
    const from = parseInt(offset as string);
    const to = from + parseInt(limit as string) - 1;

    const { data, error, count } = await supabase
      .from("attachment_eligible_students")
      .select("*", { count: "exact" })
      .is("institution_id", null)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw error;
    res.json({ data: data || [], count: count || 0 });
  } catch (err: any) {
    console.error("unassigned students error:", err);
    res.status(500).json({ error: err.message || "Failed to load unassigned students" });
  }
});

// List all institutions (for dropdown)
// institutions has country_id (FK), not a flat country column - join to get
// the display name, matching the pattern used by InstitutionRow elsewhere.
router.get("/institutions", adminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("institutions")
      .select("id, name, country:country_id(name)")
      .order("name", { ascending: true });

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err: any) {
    console.error("institutions list error:", err);
    res.status(500).json({ error: err.message || "Failed to load institutions" });
  }
});

// Assign institution to a student
router.patch("/:id/assign", adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { institution_id } = req.body;

    if (!institution_id) {
      res.status(400).json({ error: "institution_id is required" });
      return;
    }

    const { data, error } = await supabase
      .from("attachment_eligible_students")
      .update({ institution_id })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err: any) {
    console.error("assign error:", err);
    res.status(500).json({ error: err.message || "Failed to assign institution" });
  }
});

export default router;
