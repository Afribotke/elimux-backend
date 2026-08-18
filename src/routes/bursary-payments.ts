import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminAuth } from '../middleware/auth';
import { resolveTenant } from '../middleware/tenant';
import {
  createRecipient,
  initiateTransfer,
  verifyTransfer,
  parseWebhookEvent,
  verifyWebhookSignature,
  normalizePhone,
} from '../lib/paystack-disbursement';

const router = Router();

// Apply tenant resolution BEFORE adminAuth on all routes in this router
router.use(resolveTenant);

// POST /api/bursary/payments/paystack/initiate
router.post('/paystack/initiate', adminAuth, async (req, res) => {
  const tenantId = req.tenantId;
  const { applicationId, phoneNumber, amount, recipientName, reason } = req.body;

  if (!tenantId) return res.status(400).json({ error: 'Tenant required. Pass x-tenant-id header.' });
  if (!applicationId || !phoneNumber || !amount || amount <= 0) {
    return res.status(400).json({ error: 'applicationId, phoneNumber, and positive amount required' });
  }

  try {
    const { data: app } = await supabase
      .from('bursary_applications')
      .select('id, applicant_id, tenant_id, status')
      .eq('id', applicationId)
      .eq('tenant_id', tenantId)
      .single();

    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.status !== 'approved') return res.status(400).json({ error: 'Application must be approved' });

    const normalizedPhone = normalizePhone(phoneNumber);
    const name = recipientName || 'Bursary Recipient';

    const recipient = await createRecipient(name, normalizedPhone);

    const { data: disbursement, error: dErr } = await supabase
      .from('bursary_disbursements')
      .insert({
        application_id: applicationId,
        tenant_id: tenantId,
        applicant_id: app.applicant_id,
        amount,
        currency: 'KES',
        method: 'mpesa',
        status: 'initiated',
      })
      .select()
      .single();

    if (dErr) throw dErr;

    const reference = `BURSARY_${tenantId}_${disbursement.id}_${Date.now()}`;
    const transfer = await initiateTransfer(amount, recipient.recipient_code, reason || 'Bursary disbursement', reference);

    const { error: tErr } = await supabase
      .from('bursary_paystack_transfers')
      .insert({
        tenant_id: tenantId,
        disbursement_id: disbursement.id,
        recipient_code: recipient.recipient_code,
        transfer_code: transfer.transfer_code,
        reference: transfer.reference,
        amount,
        currency: 'KES',
        status: transfer.status === 'success' ? 'success' : 'pending',
        paystack_recipient_id: recipient.id,
        paystack_transfer_id: transfer.id,
        reason: reason || 'Bursary disbursement',
        recipient_name: name,
        recipient_phone: normalizedPhone,
        recipient_account: recipient.details?.account_number,
        recipient_bank_code: recipient.details?.bank_code,
      });

    if (tErr) throw tErr;

    return res.status(200).json({
      success: true,
      message: 'Transfer initiated',
      transferCode: transfer.transfer_code,
      reference: transfer.reference,
      status: transfer.status,
      disbursementId: disbursement.id,
    });
  } catch (error: any) {
    console.error('[Bursary Paystack] Initiate error:', error.message);
    return res.status(500).json({
      error: 'Failed to initiate transfer',
      details: error.message,
    });
  }
});

// POST /api/bursary/payments/paystack/webhook
// Public: Paystack calls this
router.post('/paystack/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'] as string | undefined;
  // Raw bytes, not JSON.stringify(req.body) - the app-wide express.json()
  // verify callback in index.ts already captured these onto rawBody, and
  // that's what Paystack's signature was actually computed over.
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  const event = parseWebhookEvent(req.body);
  if (!event.transferCode) return;

  const { data: transfers } = await supabase
    .from('bursary_paystack_transfers')
    .select('id, disbursement_id, tenant_id')
    .eq('transfer_code', event.transferCode);

  if (!transfers || transfers.length === 0) {
    console.error('[Paystack Webhook] Unknown transfer:', event.transferCode);
    return;
  }

  const transfer = transfers[0];

  await supabase
    .from('bursary_paystack_transfers')
    .update({
      status: event.status,
      paid_at: event.status === 'success' ? event.paidAt : null,
      failed_at: event.status === 'failed' ? event.failedAt : null,
      failed_reason: event.status === 'failed' ? event.reason : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', transfer.id);

  await supabase
    .from('bursary_disbursements')
    .update({
      status: event.status === 'success' ? 'completed' : event.status === 'failed' ? 'failed' : 'initiated',
      transaction_details: {
        paystackTransferCode: event.transferCode,
        paystackReference: event.reference,
        status: event.status,
        paidAt: event.paidAt,
        failedAt: event.failedAt,
      },
    })
    .eq('id', transfer.disbursement_id);

  console.log('[Paystack Webhook] Processed:', {
    transferCode: event.transferCode,
    status: event.status,
    amount: event.amount,
  });
});

// GET /api/bursary/payments/paystack/status/:transferCode
router.get('/paystack/status/:transferCode', adminAuth, async (req, res) => {
  const tenantId = req.tenantId;
  const { transferCode } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant required' });

  const { data, error } = await supabase
    .from('bursary_paystack_transfers')
    .select('*')
    .eq('transfer_code', transferCode)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Transfer not found' });

  return res.status(200).json({
    status: data.status,
    amount: data.amount,
    recipientName: data.recipient_name,
    recipientPhone: data.recipient_phone,
    reference: data.reference,
    transferCode: data.transfer_code,
    paidAt: data.paid_at,
    failedAt: data.failed_at,
    createdAt: data.created_at,
  });
});

// POST /api/bursary/payments/paystack/verify/:transferCode
router.post('/paystack/verify/:transferCode', adminAuth, async (req, res) => {
  const tenantId = req.tenantId;
  const { transferCode } = req.params;

  if (!tenantId) return res.status(400).json({ error: 'Tenant required' });

  try {
    const paystackData = await verifyTransfer(String(transferCode));

    await supabase
      .from('bursary_paystack_transfers')
      .update({
        status: paystackData.status,
        paid_at: paystackData.paid_at,
        updated_at: new Date().toISOString(),
      })
      .eq('transfer_code', transferCode)
      .eq('tenant_id', tenantId);

    return res.status(200).json({
      paystackStatus: paystackData.status,
      amount: paystackData.amount / 100,
      recipient: paystackData.recipient,
      createdAt: paystackData.created_at,
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'Verification failed', details: error.message });
  }
});

export default router;
