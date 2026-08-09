import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireUser } from '../middleware/user-auth';

const router = Router();

// Employers and university admins aren't recorded in user_roles (that table
// is only populated for platform admin-tier accounts) - they're identified
// by owning a row in employers/institutions instead. Checking those first
// avoids misclassifying every real employer/university account as 'student'.
async function getUserRole(userId: string): Promise<'student' | 'employer' | 'university_admin'> {
  const { data: emp } = await supabase.from('employers').select('id').eq('user_id', userId).maybeSingle();
  if (emp) return 'employer';

  const { data: inst } = await supabase.from('institutions').select('id').eq('admin_user_id', userId).maybeSingle();
  if (inst) return 'university_admin';

  return 'student';
}

router.get('/', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const role = await getUserRole(userId);
    let query = supabase.from('attachments').select(`*, student:student_id(id, email, raw_user_meta_data), university:university_id(id, name), employer:employer_id(id, company_name)`);

    if (role === 'student') {
      query = query.eq('student_id', userId);
    } else if (role === 'employer') {
      const { data: emp } = await supabase.from('employers').select('id').eq('user_id', userId).single();
      if (emp) query = query.eq('employer_id', emp.id); else return res.json({ data: [] });
    } else if (role === 'university_admin') {
      const { data: insts } = await supabase.from('institutions').select('id').eq('admin_user_id', userId);
      const ids = insts?.map(i => i.id) || [];
      if (ids.length === 0) return res.json({ data: [] });
      query = query.in('university_id', ids);
    }

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ data: data || [] });
  } catch (err: any) {
    console.error('GET /api/attachments error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.post('/', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const role = await getUserRole(userId);
    if (role !== 'university_admin') return res.status(403).json({ error: 'Only university admins can create attachments' });

    // university_id is derived from the caller's own institution, never
    // trusted from the request body - otherwise any university_admin could
    // submit an arbitrary university_id and create placements attributed to
    // an institution they don't actually manage.
    const { data: inst } = await supabase.from('institutions').select('id').eq('admin_user_id', userId).maybeSingle();
    if (!inst) return res.status(403).json({ error: 'No institution is associated with this account' });
    const university_id = inst.id;

    const { student_id, employer_id, department, supervisor_name, supervisor_email, supervisor_phone, start_date, end_date } = req.body;
    if (!student_id || !employer_id || !start_date) {
      return res.status(400).json({ error: 'student_id, employer_id, and start_date are required' });
    }

    const { data: eligible, error: eligError } = await supabase
      .from('attachment_eligible_students').select('id').eq('user_id', student_id).eq('institution_id', university_id).maybeSingle();
    if (eligError || !eligible) return res.status(400).json({ error: 'Student is not eligible for attachment at this university' });

    const { data, error } = await supabase.from('attachments').insert({
      student_id, university_id, employer_id, department, supervisor_name, supervisor_email, supervisor_phone, start_date, end_date, status: 'active'
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ data });
  } catch (err: any) {
    console.error('POST /api/attachments error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.get('/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('attachments').select(`*, student:student_id(id, email), university:university_id(id, name), employer:employer_id(id, company_name)`).eq('id', id).single();
    if (error) return res.status(404).json({ error: 'Attachment not found' });
    return res.json({ data });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

router.put('/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('attachments').update(req.body).eq('id', id).select().single();
    if (error) throw error;
    return res.json({ data });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('attachments').delete().eq('id', id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// LOGBOOK
router.get('/:id/logbook', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('logbook_entries').select('*').eq('attachment_id', id).order('entry_date', { ascending: false });
    if (error) throw error;
    return res.json({ data: data || [] });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

router.post('/:id/logbook', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { entry_date, week_number, tasks_completed, skills_learned, challenges_faced, hours_worked } = req.body;
    if (!entry_date || !tasks_completed) return res.status(400).json({ error: 'entry_date and tasks_completed are required' });
    const { data, error } = await supabase.from('logbook_entries').insert({
      attachment_id: id, entry_date, week_number, tasks_completed, skills_learned, challenges_faced, hours_worked: hours_worked || 0
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ data });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

// EVALUATIONS
router.get('/:id/evaluation', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('attachment_evaluations').select('*').eq('attachment_id', id).maybeSingle();
    if (error) throw error;
    return res.json({ data });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

router.post('/:id/evaluation', requireUser, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId;
    const { data: emp } = await supabase.from('employers').select('id').eq('user_id', userId).single();
    if (!emp) return res.status(403).json({ error: 'Only employers can evaluate' });

    const { data, error } = await supabase.from('attachment_evaluations').insert({
      attachment_id: id, employer_id: emp.id, ...req.body
    }).select().single();
    if (error) throw error;

    if (req.body.overall_score !== undefined) {
      await supabase.from('attachments').update({ evaluation_score: req.body.overall_score }).eq('id', id);
    }
    return res.status(201).json({ data });
  } catch (err: any) { return res.status(500).json({ error: err.message }); }
});

export default router;
