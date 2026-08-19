import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminAuth } from '../middleware/auth';

const router = Router();

function applicantSummary(applicant: any) {
  const info = applicant?.personal_info || {};
  return {
    id: applicant?.id,
    fullName: info.full_name || null,
    email: info.email || null,
    phone: info.phone || null,
  };
}

// GET /api/admin/bursary-applications
// Protected: super admin only
router.get('/', adminAuth, async (req, res) => {
  const { status, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string) || 1;
  const limitNum = parseInt(limit as string) || 20;
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('bursary_applications')
    .select('id, tenant_id, status, created_at, updated_at, applicant:bursary_applicants(id, personal_info), fund:bursary_funds(id, name)', {
      count: 'exact',
    });

  if (status && status !== 'all') {
    query = query.eq('status', status as string);
  }

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limitNum - 1);
  if (error) return res.status(500).json({ error: error.message });

  const applications = (data || []).map((a: any) => ({
    id: a.id,
    tenantId: a.tenant_id,
    status: a.status,
    createdAt: a.created_at,
    applicant: applicantSummary(a.applicant),
    fund: { id: a.fund?.id, name: a.fund?.name },
  }));

  return res.status(200).json({
    applications,
    pagination: { page: pageNum, limit: limitNum, total: count || 0, totalPages: Math.ceil((count || 0) / limitNum) },
  });
});

// GET /api/admin/bursary-applications/:id
router.get('/:id', adminAuth, async (req, res) => {
  const { id } = req.params;

  const { data: application, error } = await supabase
    .from('bursary_applications')
    .select('*, applicant:bursary_applicants(*), fund:bursary_funds(*)')
    .eq('id', id)
    .single();

  if (error || !application) return res.status(404).json({ error: 'Application not found' });

  const { data: documents } = await supabase
    .from('bursary_documents')
    .select('id, type, file_url, status, risk_score, uploaded_at')
    .eq('applicant_id', (application as any).applicant_id);

  return res.status(200).json({
    application: {
      id: (application as any).id,
      status: (application as any).status,
      createdAt: (application as any).created_at,
      submissionData: (application as any).submission_data,
      applicant: (application as any).applicant,
      fund: (application as any).fund,
      documents: documents || [],
    },
  });
});

// POST /api/admin/bursary-applications/:id/approve
// Updates bursary_applications.status, the linked
// bursary_applicants.application_status (the schema keeps these two in
// sync by convention, same as noted in the Cycle 015 blueprint this schema
// was built from), and provider_decision - the jsonb column this schema
// actually has for approved_at/decided_by/reason, rather than the flat
// approved_at/approved_by columns the instruction asked for, which don't
// exist on this table. decided_by is left null: adminAuth (confirmed via
// grep in Cycle 020) never attaches a per-admin identity to req - its
// x-admin-key path is a shared secret, not tied to one admin - so there is
// currently no real value to put there, and writing something misleading
// (like always "admin") would be worse than an honest null.
router.post('/:id/approve', adminAuth, async (req, res) => {
  const { id } = req.params;

  const { data: application, error: findErr } = await supabase
    .from('bursary_applications')
    .select('id, applicant_id')
    .eq('id', id)
    .single();

  if (findErr || !application) return res.status(404).json({ error: 'Application not found' });

  const decidedAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('bursary_applications')
    .update({
      status: 'approved',
      provider_decision: { status: 'approved', decided_by: null, decided_at: decidedAt },
      updated_at: decidedAt,
    })
    .eq('id', id)
    .select()
    .single();

  if (error || !updated) return res.status(500).json({ error: error?.message || 'Failed to approve application' });

  await supabase
    .from('bursary_applicants')
    .update({ application_status: 'approved', updated_at: decidedAt })
    .eq('id', (application as any).applicant_id);

  console.log(`[Admin] Bursary application approved: ${id}`);
  return res.status(200).json({ success: true, application: updated });
});

// POST /api/admin/bursary-applications/:id/reject
router.post('/:id/reject', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const { data: application, error: findErr } = await supabase
    .from('bursary_applications')
    .select('id, applicant_id')
    .eq('id', id)
    .single();

  if (findErr || !application) return res.status(404).json({ error: 'Application not found' });

  const decidedAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('bursary_applications')
    .update({
      status: 'rejected',
      provider_decision: { status: 'rejected', decided_by: null, decided_at: decidedAt, reason: reason || null },
      updated_at: decidedAt,
    })
    .eq('id', id)
    .select()
    .single();

  if (error || !updated) return res.status(500).json({ error: error?.message || 'Failed to reject application' });

  await supabase
    .from('bursary_applicants')
    .update({ application_status: 'rejected', updated_at: decidedAt })
    .eq('id', (application as any).applicant_id);

  console.log(`[Admin] Bursary application rejected: ${id}. Reason: ${reason || 'none'}`);
  return res.status(200).json({ success: true, application: updated });
});

export default router;
