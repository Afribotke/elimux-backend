import { Router } from "express";
import { adminMiddleware } from "../middleware/auth";
import { supabase } from "../lib/supabase";
import { sendEmail } from "../lib/email";

const router = Router();

interface ManagerInfo {
  id: string;
  email: string;
  role: string;
}

// Batch-resolves admin_users rows by id, separately from the row(s) that
// reference them. PostgREST embeds (assigned:assigned_to(...)) depend on it
// having a cached FK relationship for employer_outreach/outreach_team ->
// admin_users, which has proven unreliable here (500s with "Could not find
// a relationship" even though both tables are in the public schema - the
// migration's FK apparently isn't visible to the schema cache yet). Doing
// two plain queries and merging in JS sidesteps that entirely, matching the
// existing attachStudentInfo pattern in attachments.ts.
async function fetchManagersByIds(ids: Array<string | null | undefined>): Promise<Map<string, ManagerInfo>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => !!id))];
  if (uniqueIds.length === 0) return new Map();
  const { data, error } = await supabase.from("admin_users").select("id, email, role").in("id", uniqueIds);
  if (error) throw error;
  return new Map((data || []).map((m: any) => [m.id, m as ManagerInfo]));
}

// List all employer_names with outreach data
router.get("/", adminMiddleware, async (req, res) => {
  try {
    const {
      status = "",
      assigned_to = "",
      priority = "",
      search = "",
      page = "1",
      limit = "50",
    } = req.query;

    const from = (parseInt(page as string) - 1) * parseInt(limit as string);
    const to = from + parseInt(limit as string) - 1;

    let query = supabase
      .from("employer_names")
      .select(
        `
        id, name, created_at,
        outreach:employer_outreach(
          id, status, priority, notes, research_data, last_contact_date,
          next_follow_up_date, invitation_sent_at, assigned_to, supervised_by
        )
      `,
        { count: "exact" }
      )
      .order("name", { ascending: true })
      .range(from, to);

    if (search) {
      query = query.ilike("name", `%${search}%`);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    let rows = data || [];

    const managerIds = rows.flatMap((e: any) => [e.outreach?.[0]?.assigned_to, e.outreach?.[0]?.supervised_by]);
    const managerMap = await fetchManagersByIds(managerIds);

    let filtered = rows.map((e: any) => {
      const out = e.outreach?.[0];
      if (!out) return e;
      return {
        ...e,
        outreach: [
          {
            ...out,
            assigned: out.assigned_to ? managerMap.get(out.assigned_to) || null : null,
            supervisor: out.supervised_by ? managerMap.get(out.supervised_by) || null : null,
          },
        ],
      };
    });

    if (status) {
      filtered = filtered.filter((e: any) => e.outreach?.[0]?.status === status);
    }
    if (assigned_to) {
      filtered = filtered.filter((e: any) => e.outreach?.[0]?.assigned_to === assigned_to);
    }
    if (priority) {
      filtered = filtered.filter((e: any) => e.outreach?.[0]?.priority === parseInt(priority as string));
    }

    res.json({ data: filtered, count: count || 0 });
  } catch (err: any) {
    console.error("outreach list error:", err);
    res.status(500).json({ error: err.message || "Failed to load outreach data" });
  }
});

// Roster of admin_users for assignment pickers
router.get("/managers", adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("admin_users")
      .select("id, email, role")
      .eq("is_active", true)
      .order("email", { ascending: true });
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err: any) {
    console.error("outreach managers error:", err);
    res.status(500).json({ error: err.message || "Failed to load managers" });
  }
});

// Get single employer with full outreach history
router.get("/:employerNameId", adminMiddleware, async (req, res) => {
  try {
    const employerNameId = req.params.employerNameId as string;

    const { data: employer, error: empErr } = await supabase
      .from("employer_names")
      .select("*")
      .eq("id", employerNameId)
      .single();

    if (empErr) throw empErr;

    const { data: outreachRow, error: outErr } = await supabase
      .from("employer_outreach")
      .select("*")
      .eq("employer_name_id", employerNameId)
      .maybeSingle();

    if (outErr) throw outErr;

    let outreach: any = outreachRow;
    let activities: any[] = [];

    if (outreach) {
      const managerMap = await fetchManagersByIds([outreach.assigned_to, outreach.supervised_by]);
      outreach = {
        ...outreach,
        assigned: outreach.assigned_to ? managerMap.get(outreach.assigned_to) || null : null,
        supervisor: outreach.supervised_by ? managerMap.get(outreach.supervised_by) || null : null,
      };

      const { data: activityData, error: actErr } = await supabase
        .from("outreach_activity_logs")
        .select("*")
        .eq("employer_outreach_id", outreachRow!.id)
        .order("created_at", { ascending: false });

      if (actErr) throw actErr;

      const performerMap = await fetchManagersByIds((activityData || []).map((a: any) => a.performed_by));
      activities = (activityData || []).map((a: any) => ({
        ...a,
        performer: a.performed_by ? performerMap.get(a.performed_by) || null : null,
      }));
    }

    res.json({
      data: {
        employer,
        outreach,
        activities,
      },
    });
  } catch (err: any) {
    console.error("outreach detail error:", err);
    res.status(500).json({ error: err.message || "Failed to load detail" });
  }
});

// Assign account manager / supervisor
router.patch("/:employerNameId/assign", adminMiddleware, async (req, res) => {
  try {
    const employerNameId = req.params.employerNameId as string;
    const { assigned_to, supervised_by, notes } = req.body;

    const { data: existing } = await supabase
      .from("employer_outreach")
      .select("id")
      .eq("employer_name_id", employerNameId)
      .maybeSingle();

    let outreachId;
    if (existing) {
      const { data, error } = await supabase
        .from("employer_outreach")
        .update({ assigned_to, supervised_by, notes, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw error;
      outreachId = data.id;
    } else {
      const { data, error } = await supabase
        .from("employer_outreach")
        .insert({ employer_name_id: employerNameId, assigned_to, supervised_by, notes })
        .select()
        .single();
      if (error) throw error;
      outreachId = data.id;
    }

    await supabase.from("outreach_activity_logs").insert({
      employer_outreach_id: outreachId,
      action: "assigned",
      details: { assigned_to, supervised_by, notes },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error("assign error:", err);
    res.status(500).json({ error: err.message || "Failed to assign" });
  }
});

// Update status
router.patch("/:employerNameId/status", adminMiddleware, async (req, res) => {
  try {
    const employerNameId = req.params.employerNameId as string;
    const { status, notes } = req.body;

    const { data: outreach } = await supabase
      .from("employer_outreach")
      .select("id")
      .eq("employer_name_id", employerNameId)
      .maybeSingle();

    if (!outreach) {
      res.status(404).json({ error: "Outreach record not found" });
      return;
    }

    const updates: any = { status, updated_at: new Date().toISOString() };
    if (status === "contacted") updates.last_contact_date = new Date().toISOString();

    await supabase.from("employer_outreach").update(updates).eq("id", outreach.id);

    await supabase.from("outreach_activity_logs").insert({
      employer_outreach_id: outreach.id,
      action: "status_changed",
      details: { new_status: status, notes },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error("status update error:", err);
    res.status(500).json({ error: err.message || "Failed to update status" });
  }
});

// Add research data
router.patch("/:employerNameId/research", adminMiddleware, async (req, res) => {
  try {
    const employerNameId = req.params.employerNameId as string;
    const { research_data, notes } = req.body;

    const { data: outreach } = await supabase
      .from("employer_outreach")
      .select("id")
      .eq("employer_name_id", employerNameId)
      .maybeSingle();

    if (!outreach) {
      // Auto-create the outreach row so research can be saved before assignment.
      const { data: created, error: createErr } = await supabase
        .from("employer_outreach")
        .insert({ employer_name_id: employerNameId, research_data, notes, status: "researched" })
        .select("id")
        .single();
      if (createErr) throw createErr;

      await supabase.from("outreach_activity_logs").insert({
        employer_outreach_id: created.id,
        action: "researched",
        details: { research_data, notes },
      });

      res.json({ success: true });
      return;
    }

    await supabase
      .from("employer_outreach")
      .update({
        research_data,
        notes,
        status: "researched",
        updated_at: new Date().toISOString(),
      })
      .eq("id", outreach.id);

    await supabase.from("outreach_activity_logs").insert({
      employer_outreach_id: outreach.id,
      action: "researched",
      details: { research_data, notes },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error("research error:", err);
    res.status(500).json({ error: err.message || "Failed to save research" });
  }
});

// Send invitation email
router.post("/:employerNameId/invite", adminMiddleware, async (req, res) => {
  try {
    const employerNameId = req.params.employerNameId as string;
    const { email } = req.body;

    const { data: employer } = await supabase
      .from("employer_names")
      .select("*")
      .eq("id", employerNameId)
      .single();

    if (!employer) {
      res.status(404).json({ error: "Employer not found" });
      return;
    }

    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const claimUrl = `${process.env.FRONTEND_URL || "https://elimux.ke"}/employer/claim/${token}`;

    await sendEmail({
      to: email,
      subject: `Claim your company profile on ElimuX - ${employer.name}`,
      html: `
        <h2>Hello ${employer.name},</h2>
        <p>Your company has been listed on <strong>ElimuX</strong>, Kenya's leading education and career discovery platform.</p>
        <p>Students and graduates are searching for opportunities with employers like you.</p>
        <p><a href="${claimUrl}" style="background:#EAB308;color:#000;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">Claim Your Profile</a></p>
        <p>By claiming your profile, you can:</p>
        <ul>
          <li>Post internships and attachments</li>
          <li>Manage your company information</li>
          <li>Review and hire student talent</li>
        </ul>
        <p>If you have questions, reply to this email.</p>
        <p>Best,<br>The ElimuX Team</p>
      `,
    });

    const { data: existingOutreach } = await supabase
      .from("employer_outreach")
      .select("id")
      .eq("employer_name_id", employerNameId)
      .maybeSingle();

    let outreachId = existingOutreach?.id;
    if (!outreachId) {
      const { data: created, error: createErr } = await supabase
        .from("employer_outreach")
        .insert({ employer_name_id: employerNameId })
        .select("id")
        .single();
      if (createErr) throw createErr;
      outreachId = created.id;
    }

    await supabase
      .from("employer_outreach")
      .update({
        status: "invited",
        invitation_sent_at: new Date().toISOString(),
        invitation_token: token,
        updated_at: new Date().toISOString(),
      })
      .eq("id", outreachId);

    await supabase.from("outreach_activity_logs").insert({
      employer_outreach_id: outreachId,
      action: "invited",
      details: { email, token },
    });

    res.json({ success: true, claim_url: claimUrl });
  } catch (err: any) {
    console.error("invite error:", err);
    res.status(500).json({ error: err.message || "Failed to send invitation" });
  }
});

// Bulk invite - only sends to employers that already have a research email saved
router.post("/bulk-invite", adminMiddleware, async (req, res) => {
  try {
    const { employerNameIds } = req.body;
    const results = { sent: 0, failed: 0, noEmail: 0 };

    for (const id of employerNameIds) {
      try {
        const { data: outreach } = await supabase
          .from("employer_outreach")
          .select("id, research_data")
          .eq("employer_name_id", id)
          .maybeSingle();

        const email = outreach?.research_data?.email;
        if (!email) {
          results.noEmail++;
          continue;
        }

        const { data: employer } = await supabase
          .from("employer_names")
          .select("name")
          .eq("id", id)
          .single();

        const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const claimUrl = `${process.env.FRONTEND_URL || "https://elimux.ke"}/employer/claim/${token}`;

        await sendEmail({
          to: email,
          subject: `Claim your profile on ElimuX - ${employer?.name || "Your Company"}`,
          html: `<p>Your company is listed on ElimuX. <a href="${claimUrl}">Claim your profile</a> to post internships and connect with talent.</p>`,
        });

        await supabase
          .from("employer_outreach")
          .update({ status: "invited", invitation_sent_at: new Date().toISOString(), invitation_token: token })
          .eq("id", outreach!.id);

        results.sent++;
      } catch {
        results.failed++;
      }
    }

    res.json({ data: results });
  } catch (err: any) {
    console.error("bulk invite error:", err);
    res.status(500).json({ error: err.message || "Bulk invite failed" });
  }
});

// Team management
router.get("/team/members", adminMiddleware, async (req, res) => {
  try {
    const { data: team, error } = await supabase.from("outreach_team").select("*");
    if (error) throw error;

    const rows = team || [];
    const managerMap = await fetchManagersByIds(rows.flatMap((t: any) => [t.user_id, t.reports_to]));

    const enriched = rows.map((t: any) => ({
      ...t,
      user: t.user_id ? managerMap.get(t.user_id) || null : null,
      manager: t.reports_to ? managerMap.get(t.reports_to) || null : null,
    }));

    res.json({ data: enriched });
  } catch (err: any) {
    console.error("team error:", err);
    res.status(500).json({ error: err.message || "Failed to load team" });
  }
});

router.post("/team/members", adminMiddleware, async (req, res) => {
  try {
    const { user_id, role, reports_to } = req.body;
    const { data, error } = await supabase
      .from("outreach_team")
      .upsert({ user_id, role, reports_to: reports_to || null }, { onConflict: "user_id" })
      .select()
      .single();

    if (error) throw error;
    res.json({ data });
  } catch (err: any) {
    console.error("team add error:", err);
    res.status(500).json({ error: err.message || "Failed to add team member" });
  }
});

router.delete("/team/members/:id", adminMiddleware, async (req, res) => {
  try {
    const id = req.params.id as string;
    const { error } = await supabase.from("outreach_team").delete().eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    console.error("team remove error:", err);
    res.status(500).json({ error: err.message || "Failed to remove team member" });
  }
});

// Performance dashboard
router.get("/stats/dashboard", adminMiddleware, async (req, res) => {
  try {
    const { data: statusCounts, error: statusErr } = await supabase
      .from("employer_outreach")
      .select("status");

    if (statusErr) throw statusErr;

    const statusBreakdown: Record<string, number> = {};
    (statusCounts || []).forEach((r: any) => {
      statusBreakdown[r.status] = (statusBreakdown[r.status] || 0) + 1;
    });

    const { data: managerStats, error: mgrErr } = await supabase
      .from("employer_outreach")
      .select("assigned_to, status")
      .not("assigned_to", "is", null);

    if (mgrErr) throw mgrErr;

    const managerMap = await fetchManagersByIds((managerStats || []).map((r: any) => r.assigned_to));

    const byManager: Record<string, { email: string; total: number; by_status: Record<string, number> }> = {};
    (managerStats || []).forEach((r: any) => {
      const key = r.assigned_to;
      if (!byManager[key]) byManager[key] = { email: managerMap.get(key)?.email || key, total: 0, by_status: {} };
      byManager[key].total++;
      byManager[key].by_status[r.status] = (byManager[key].by_status[r.status] || 0) + 1;
    });

    res.json({
      data: {
        total_employers: statusCounts?.length || 0,
        status_breakdown: statusBreakdown,
        by_manager: byManager,
      },
    });
  } catch (err: any) {
    console.error("dashboard error:", err);
    res.status(500).json({ error: err.message || "Failed to load dashboard" });
  }
});

export default router;
