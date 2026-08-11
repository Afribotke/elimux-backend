import { Router } from "express";
import { adminMiddleware } from "../middleware/auth";
import { supabase } from "../lib/supabase";

const router = Router();

// Attachment completion report
router.get("/attachments", adminMiddleware, async (req, res) => {
  try {
    const { status, from, to } = req.query;

    let query = supabase
      .from("attachments")
      .select(`
        *,
        employer:employer_id(company_name),
        university:university_id(name)
      `)
      .order("created_at", { ascending: false });

    if (status) query = query.eq("status", status);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, error } = await query;
    if (error) throw error;

    // total sourced from data.length, not a `count` from the query - the
    // .select() above never requested { count: 'exact' }, so a Supabase
    // `count` would always come back null here.
    const total = data?.length || 0;
    const completed = data?.filter((a) => a.status === "completed").length || 0;
    const active = data?.filter((a) => a.status === "active").length || 0;
    const terminated = data?.filter((a) => a.status === "terminated").length || 0;
    const pending = data?.filter((a) => a.status === "pending").length || 0;

    res.json({
      data: data || [],
      count: total,
      summary: {
        total,
        completed,
        active,
        terminated,
        pending,
        completion_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    });
  } catch (err: any) {
    console.error("attachment report error:", err);
    res.status(500).json({ error: err.message || "Failed to load report" });
  }
});

// CSV export
router.get("/export/:table", adminMiddleware, async (req, res) => {
  try {
    const table = req.params.table as string;
    const { from, to } = req.query;

    const allowedTables = ["institutions", "programs", "employers", "internships", "applications", "attachments", "contact_messages"];
    if (!allowedTables.includes(table)) {
      res.status(400).json({ error: "Invalid table name" });
      return;
    }

    let query = supabase
      .from(table)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10000);

    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      res.status(404).json({ error: "No data found" });
      return;
    }

    const headers = Object.keys(data[0]).join(",");
    const rows = data.map((row) =>
      Object.values(row).map((val) => {
        if (val === null) return "";
        if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
        const str = String(val).replace(/"/g, '""');
        return str.includes(",") || str.includes("\n") ? `"${str}"` : str;
      }).join(",")
    );

    const csv = [headers, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${table}_export_${new Date().toISOString().split("T")[0]}.csv"`);
    res.send(csv);
  } catch (err: any) {
    console.error("export error:", err);
    res.status(500).json({ error: err.message || "Failed to export data" });
  }
});

export default router;
