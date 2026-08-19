import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminAuth } from '../middleware/auth';

const router = Router();

// GET /api/admin/bursary-funds
// Protected: super admin only
router.get('/', adminAuth, async (req, res) => {
  const { status, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string) || 1;
  const limitNum = parseInt(limit as string) || 20;
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('bursary_funds')
    .select('id, tenant_id, name, description, fund_type, status, budget, application_window, eligibility_rules, required_documents, created_at, updated_at, applications:bursary_applications(count)', {
      count: 'exact',
    });

  if (status && status !== 'all') {
    query = query.eq('status', status as string);
  }

  const { data: funds, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limitNum - 1);

  if (error) return res.status(500).json({ error: error.message });

  const rows = (funds || []).map((f: any) => ({
    ...f,
    applicant_count: f.applications?.[0]?.count ?? 0,
    applications: undefined,
  }));

  return res.status(200).json({
    funds: rows,
    pagination: { page: pageNum, limit: limitNum, total: count || 0, totalPages: Math.ceil((count || 0) / limitNum) },
  });
});

// GET /api/admin/bursary-funds/tenants - active tenants, for the "which provider owns this fund" selector.
// A fund cannot exist without a tenant_id (NOT NULL) - the source instruction's
// create-fund form has no tenant field at all, which would make every create
// call fail its NOT NULL constraint. Added this lookup rather than silently
// picking a tenant or inventing a "platform default" that doesn't exist in the schema.
router.get('/tenants', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('tenants').select('id, name, slug').eq('status', 'active').order('name');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ tenants: data || [] });
});

// POST /api/admin/bursary-funds
router.post('/', adminAuth, async (req, res) => {
  const { tenantId, name, description, fundType, totalAmount, currency, deadline, opensAt, eligibilityRules, requiredDocuments } = req.body;

  if (!tenantId || !name) {
    return res.status(400).json({ error: 'tenantId and name are required' });
  }

  const { data, error } = await supabase
    .from('bursary_funds')
    .insert({
      tenant_id: tenantId,
      name,
      description: description || null,
      fund_type: fundType || 'open',
      status: 'draft',
      budget: { total: totalAmount || 0, committed: 0, disbursed: 0, currency: currency || 'KES' },
      application_window: { opens_at: opensAt || null, deadline: deadline || null },
      eligibility_rules: eligibilityRules || {},
      required_documents: requiredDocuments || [],
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ success: true, fund: data });
});

// PATCH /api/admin/bursary-funds/:id
router.patch('/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { name, description, fundType, status, totalAmount, currency, deadline, opensAt, eligibilityRules, requiredDocuments } = req.body;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (fundType !== undefined) update.fund_type = fundType;
  if (status !== undefined) update.status = status;
  if (eligibilityRules !== undefined) update.eligibility_rules = eligibilityRules;
  if (requiredDocuments !== undefined) update.required_documents = requiredDocuments;
  if (totalAmount !== undefined || currency !== undefined) {
    const { data: existing } = await supabase.from('bursary_funds').select('budget').eq('id', id).single();
    const currentBudget = (existing?.budget as Record<string, unknown>) || {};
    update.budget = { ...currentBudget, ...(totalAmount !== undefined ? { total: totalAmount } : {}), ...(currency !== undefined ? { currency } : {}) };
  }
  if (deadline !== undefined || opensAt !== undefined) {
    const { data: existing } = await supabase.from('bursary_funds').select('application_window').eq('id', id).single();
    const currentWindow = (existing?.application_window as Record<string, unknown>) || {};
    update.application_window = { ...currentWindow, ...(deadline !== undefined ? { deadline } : {}), ...(opensAt !== undefined ? { opens_at: opensAt } : {}) };
  }

  const { data, error } = await supabase.from('bursary_funds').update(update).eq('id', id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Fund not found' });
  return res.status(200).json({ success: true, fund: data });
});

// DELETE /api/admin/bursary-funds/:id
// Soft-delete only (status -> 'cancelled'), matching the immutable-ledger-adjacent
// design used elsewhere in the bursary schema (disbursements are never hard-deleted
// either) - a hard DELETE here would also orphan any bursary_applications already
// pointing at this fund (fund_id has no ON DELETE CASCADE from applications' side).
router.delete('/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('bursary_funds')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Fund not found' });
  return res.status(200).json({ success: true, fund: data });
});

export default router;
