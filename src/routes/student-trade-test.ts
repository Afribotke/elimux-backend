import { Router } from "express";
import { supabase } from "../lib/supabase";

const router = Router();

// Get student's trade-test eligibility
router.get("/eligibility", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const studentId = user.id;

    // Query attachments directly — status, start_date, end_date, certificate_issued, certificate_url
    const { data: attachments, error: attachError } = await supabase
      .from("attachments")
      .select(`
        id,
        status,
        start_date,
        end_date,
        certificate_issued,
        certificate_url,
        employer:employer_id(company_name),
        university:university_id(name)
      `)
      .eq("student_id", studentId)
      .order("created_at", { ascending: false });

    if (attachError) throw attachError;

    const list = attachments || [];

    // Calculate completed count and total weeks
    const completed = list.filter((a) => a.status === "completed");
    const completedCount = completed.length;

    let totalWeeks = 0;
    for (const a of completed) {
      if (a.start_date && a.end_date) {
        const start = new Date(a.start_date);
        const end = new Date(a.end_date);
        const diffMs = end.getTime() - start.getTime();
        const weeks = Math.round(diffMs / (1000 * 60 * 60 * 24 * 7));
        if (weeks > 0) totalWeeks += weeks;
      }
    }

    // NITA grade thresholds
    const eligibleGrades: string[] = [];
    if (totalWeeks >= 12) eligibleGrades.push("Grade III");
    if (totalWeeks >= 24) eligibleGrades.push("Grade II");
    if (totalWeeks >= 36) eligibleGrades.push("Grade I");

    res.json({
      data: {
        student_id: studentId,
        completed_attachments: completedCount,
        total_weeks: totalWeeks,
        attachments: list,
        eligible_grades: eligibleGrades,
        is_eligible: eligibleGrades.length > 0,
        next_grade: eligibleGrades[eligibleGrades.length - 1] || null,
      },
    });
  } catch (err: any) {
    console.error("trade test eligibility error:", err);
    res.status(500).json({ error: err.message || "Failed to check eligibility" });
  }
});

// Get certificates for student
router.get("/certificates", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }

    const { data, error } = await supabase
      .from("attachments")
      .select(`
        id,
        status,
        start_date,
        end_date,
        certificate_issued,
        certificate_url,
        employer:employer_id(company_name),
        university:university_id(name)
      `)
      .eq("student_id", user.id)
      .eq("certificate_issued", true)
      .not("certificate_url", "is", null)
      .order("end_date", { ascending: false });

    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err: any) {
    console.error("certificates error:", err);
    res.status(500).json({ error: err.message || "Failed to load certificates" });
  }
});

export default router;
