import { Router } from "express";
import { employerAuth, EmployerAuthRequest } from "../middleware/employer-auth";
import { supabase } from "../lib/supabase";

const router = Router();

// attachments.student_id references auth.users, which PostgREST can't embed
// across schemas - fetch student display info separately via the admin API,
// same workaround already used in attachments.ts's attachStudentInfo().
async function withStudentNames<T extends { student_id?: string }>(rows: T[]) {
  const results: (T & { student_name: string })[] = [];
  for (const row of rows) {
    let student_name = "Unknown";
    if (row.student_id) {
      const { data: userData } = await supabase.auth.admin.getUserById(row.student_id);
      // student_name is the field actually set in user_metadata at signup
      // (see elimux-frontend app/api/institutions/attachment/upload/route.ts) -
      // not full_name.
      student_name = userData?.user?.user_metadata?.student_name || userData?.user?.email || "Unknown";
    }
    results.push({ ...row, student_name });
  }
  return results;
}

// List completed attachments for this employer that lack an evaluation.
// Filtering is done as two queries + a JS set-diff rather than a nested
// PostgREST "not.in" subquery - that operator expects a literal
// comma-separated value list, not an executable SQL subquery, so embedding
// "(select ... from ...)" as the filter value would 400 rather than run it.
router.get("/pending", employerAuth, async (req: EmployerAuthRequest, res) => {
  try {
    const employerId = req.employerId;
    if (!employerId) {
      res.status(403).json({ error: "Employer not authenticated" });
      return;
    }

    const { data: attachments, error: attachError } = await supabase
      .from("attachments")
      .select("id, student_id, start_date, end_date, status, created_at")
      .eq("employer_id", employerId)
      .eq("status", "completed")
      .order("end_date", { ascending: false });
    if (attachError) throw attachError;

    const { data: evaluations, error: evalError } = await supabase
      .from("attachment_evaluations")
      .select("attachment_id")
      .eq("employer_id", employerId);
    if (evalError) throw evalError;

    const evaluatedIds = new Set((evaluations || []).map((e) => e.attachment_id));
    const pending = (attachments || []).filter((a) => !evaluatedIds.has(a.id));

    res.json({ data: await withStudentNames(pending) });
  } catch (err: any) {
    console.error("pending evaluations error:", err);
    res.status(500).json({ error: err.message || "Failed to load pending evaluations" });
  }
});

// List attachments this employer has already evaluated
router.get("/submitted", employerAuth, async (req: EmployerAuthRequest, res) => {
  try {
    const employerId = req.employerId;
    if (!employerId) {
      res.status(403).json({ error: "Employer not authenticated" });
      return;
    }

    const { data, error } = await supabase
      .from("attachment_evaluations")
      .select("*, attachment:attachment_id(id, start_date, end_date, student_id)")
      .eq("employer_id", employerId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const rows = (data || []).map((ev: any) => ({ ...ev, student_id: ev.attachment?.student_id }));
    res.json({ data: await withStudentNames(rows) });
  } catch (err: any) {
    console.error("submitted evaluations error:", err);
    res.status(500).json({ error: err.message || "Failed to load submitted evaluations" });
  }
});

export default router;
