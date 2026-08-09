import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { employerAuth, requireEmployerManage, EmployerAuthRequest } from '../middleware/employer-auth';

const router = Router();

const MANAGE_OR_CREATE_ROLES = ['super_admin', 'admin', 'manager'];

// GET /api/requisitions — any active team member of the employer
router.get('/', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('internship_requisitions')
      .select(`*, department:department_id(id, name)`)
      .eq('employer_id', req.employerId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [], role: req.employerRole, can_create: MANAGE_OR_CREATE_ROLES.includes(req.employerRole || ''), can_approve: ['super_admin', 'admin'].includes(req.employerRole || '') });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/requisitions/:id
router.get('/:id', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('internship_requisitions')
      .select(`*, department:department_id(id, name)`)
      .eq('id', req.params.id)
      .eq('employer_id', req.employerId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Requisition not found' });
      return;
    }
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/requisitions — manager/admin/super_admin submits a request.
// requested_by and employer_id are always derived server-side, never
// trusted from the client.
router.post('/', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    if (!MANAGE_OR_CREATE_ROLES.includes(req.employerRole || '')) {
      res.status(403).json({ success: false, error: 'Only managers and above can submit requisitions' });
      return;
    }

    const {
      department_id, title, description, requirements, skills_required,
      duration_months, number_of_slots, stipend_amount, stipend_currency,
      location_type, location_city, start_date
    } = req.body || {};

    if (!title || !description) {
      res.status(400).json({ success: false, error: 'title and description are required' });
      return;
    }

    const { data, error } = await supabase
      .from('internship_requisitions')
      .insert({
        employer_id: req.employerId,
        department_id: department_id || null,
        title,
        description,
        requirements: Array.isArray(requirements) ? requirements : (requirements ? [requirements] : []),
        skills_required: Array.isArray(skills_required) ? skills_required : (skills_required ? [skills_required] : []),
        duration_months: duration_months || null,
        number_of_slots: number_of_slots || 1,
        stipend_amount: stipend_amount || null,
        stipend_currency: stipend_currency || 'KES',
        location_type: location_type || null,
        location_city: location_city || null,
        start_date: start_date || null,
        status: 'pending_approval',
        requested_by: req.userId
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/requisitions/:id/approve — admin/super_admin only. Approving
// atomically posts the requisition as a live internship (see
// approve_requisition() - migration 36).
router.post('/:id/approve', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: reqRow } = await supabase
      .from('internship_requisitions')
      .select('id')
      .eq('id', req.params.id)
      .eq('employer_id', req.employerId)
      .single();

    if (!reqRow) {
      res.status(404).json({ success: false, error: 'Requisition not found' });
      return;
    }

    const { data: internshipId, error } = await supabase.rpc('approve_requisition', {
      p_requisition_id: req.params.id,
      p_approved_by: req.userId,
      p_notes: req.body?.notes || null
    });

    if (error) throw error;
    res.json({ success: true, message: 'Requisition approved and internship posted', internship_id: internshipId });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/requisitions/:id/reject — admin/super_admin only
router.post('/:id/reject', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: reqRow } = await supabase
      .from('internship_requisitions')
      .select('id')
      .eq('id', req.params.id)
      .eq('employer_id', req.employerId)
      .single();

    if (!reqRow) {
      res.status(404).json({ success: false, error: 'Requisition not found' });
      return;
    }

    const { error } = await supabase.rpc('reject_requisition', {
      p_requisition_id: req.params.id,
      p_approved_by: req.userId,
      p_notes: req.body?.notes || null
    });

    if (error) throw error;
    res.json({ success: true, message: 'Requisition rejected' });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
