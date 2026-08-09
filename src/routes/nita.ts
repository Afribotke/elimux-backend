import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireUser } from '../middleware/user-auth';

const router = Router();

async function requireNitaAdmin(req: Request, res: Response, next: Function) {
  const userId = (req as any).userId;
  // A user can hold multiple roles (e.g. this test account has both
  // elimux_admin and nita_admin) - .single() errors when more than one row
  // matches, so check for any matching row instead of fetching exactly one.
  const { data } = await supabase.from('user_roles').select('role').eq('user_id', userId).in('role', ['nita_admin', 'elimux_admin', 'admin']);
  if (!data || data.length === 0) {
    return res.status(403).json({ error: 'NITA admin access required' });
  }
  next();
}

router.get('/dashboard', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try {
    const { data: attachments } = await supabase.from('attachments').select('status, evaluation_score');
    const { data: employers } = await supabase.from('employers').select('nita_verified, nita_employer_number');
    const { data: flags } = await supabase.from('nita_compliance_flags').select('*').eq('resolved', false);
    const { data: latestSnapshot } = await supabase.from('nita_stats_snapshots').select('*').order('snapshot_date', { ascending: false }).limit(1).single();

    const total = attachments?.length || 0;
    const active = attachments?.filter(a => a.status === 'active').length || 0;
    const completed = attachments?.filter(a => a.status === 'completed').length || 0;
    const scored = attachments?.filter(a => a.evaluation_score) || [];
    const avgScore = scored.length > 0 ? scored.reduce((s, a) => s + (a.evaluation_score || 0), 0) / scored.length : 0;

    res.json({
      summary: {
        total_attachments: total, active_attachments: active, completed_attachments: completed,
        completion_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
        avg_evaluation_score: Math.round(avgScore || 0),
        total_employers: employers?.length || 0,
        nita_registered_employers: employers?.filter(e => e.nita_verified).length || 0,
        compliance_rate: employers?.length ? Math.round((employers.filter(e => e.nita_verified).length / employers.length) * 100) : 0,
        open_flags: flags?.length || 0
      },
      latest_snapshot: latestSnapshot || null,
      open_flags: flags || []
    });
  } catch (err: any) { console.error('NITA dashboard error:', err); res.status(500).json({ error: err.message }); }
});

router.get('/compliance', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase.from('nita_compliance_flags').select(`*, employer:employer_id(id, company_name, nita_employer_number, user_id)`).eq('resolved', false).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/compliance/:id/resolve', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const { data, error } = await supabase.from('nita_compliance_flags').update({ resolved: true, resolved_by: userId, resolved_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ data });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/reports', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try {
    const { start_date, end_date } = req.query;
    let query = supabase.from('nita_stats_snapshots').select('*').order('snapshot_date', { ascending: false });
    if (start_date) query = query.gte('snapshot_date', start_date as string);
    if (end_date) query = query.lte('snapshot_date', end_date as string);
    const { data, error } = await query.limit(90);
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/sync-employers', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try {
    const { employers } = req.body;
    if (!Array.isArray(employers) || employers.length === 0) return res.status(400).json({ error: 'employers array required' });
    const { data, error } = await supabase.from('nita_employer_registry').upsert(employers, { onConflict: 'nita_registration_number' });
    if (error) throw error;
    await supabase.rpc('check_nita_compliance');
    res.json({ message: `Synced ${employers.length} employers`, data });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Public: renders as a trust badge on employer profile pages for anonymous visitors.
router.get('/employer/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: employer, error } = await supabase.from('employers').select('id, company_name, nita_employer_number, nita_verified, nita_verified_at, verification_status, is_verified').eq('id', id).single();
    if (error || !employer) return res.status(404).json({ error: 'Employer not found' });
    const { data: flags } = await supabase.from('nita_compliance_flags').select('*').eq('employer_id', id).eq('resolved', false);
    res.json({ employer, nita_compliant: employer.nita_verified === true && (flags?.length || 0) === 0, open_flags: flags || [] });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/run-compliance-check', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try { const { error } = await supabase.rpc('check_nita_compliance'); if (error) throw error; res.json({ message: 'Compliance check completed' }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/generate-snapshot', requireUser, requireNitaAdmin, async (req: Request, res: Response) => {
  try { const { error } = await supabase.rpc('generate_nita_snapshot'); if (error) throw error; res.json({ message: 'Snapshot generated' }); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
