import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminAuth } from '../middleware/auth';

const router = Router();

// GET /api/admin/bursary-disbursements
// Protected: super admin only. No endpoint like this existed anywhere - the
// only prior disbursement endpoints (routes/bursary-payments.ts) are
// per-transfer (initiate/status/verify), none list across all disbursements,
// which the admin table (Task 4) needs to populate at all.
router.get('/', adminAuth, async (req, res) => {
  const { status, page = '1', limit = '20' } = req.query;
  const pageNum = parseInt(page as string) || 1;
  const limitNum = parseInt(limit as string) || 20;
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('bursary_disbursements')
    .select(
      'id, tenant_id, application_id, applicant_id, amount, currency, method, status, created_at, applicant:bursary_applicants(personal_info), paystack_transfers:bursary_paystack_transfers(transfer_code, status, paid_at, failed_at)',
      { count: 'exact' }
    );

  if (status && status !== 'all') {
    query = query.eq('status', status as string);
  }

  const { data, error, count } = await query.order('created_at', { ascending: false }).range(offset, offset + limitNum - 1);
  if (error) return res.status(500).json({ error: error.message });

  const disbursements = (data || []).map((d: any) => {
    const transfer = Array.isArray(d.paystack_transfers) ? d.paystack_transfers[0] : d.paystack_transfers;
    const info = d.applicant?.personal_info || {};
    return {
      id: d.id,
      applicationId: d.application_id,
      applicantName: info.full_name || null,
      amount: d.amount,
      currency: d.currency,
      method: d.method,
      status: d.status,
      createdAt: d.created_at,
      transferCode: transfer?.transfer_code || null,
      paystackStatus: transfer?.status || null,
      paidAt: transfer?.paid_at || null,
      failedAt: transfer?.failed_at || null,
    };
  });

  return res.status(200).json({
    disbursements,
    pagination: { page: pageNum, limit: limitNum, total: count || 0, totalPages: Math.ceil((count || 0) / limitNum) },
  });
});

export default router;
