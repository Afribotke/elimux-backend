// ============================================
// ELIMUX AD PORTAL - PAYMENT ROUTES
// ============================================

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { initializeTransaction, verifyTransaction, verifyWebhookSignature, toSubunit } from '../lib/paystack';
import { advertiserAuth, AdvertiserAuthRequest } from '../middleware/advertiser-auth';
import { CreatePaymentRequest } from '../types/advertiser';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.elimux.ke';

// ad_payments has no advertiser_id column - campaign_id is the only link,
// so every payment funds a specific campaign directly (no separate wallet
// balance top-up). Marking it paid also credits the owning advertiser's
// total_spent for reporting.
async function applySuccessfulPayment(payment: any, paystackStatus: string): Promise<void> {
    await supabaseAdmin
        .from('ad_payments')
        .update({
            status: 'completed',
            paystack_status: paystackStatus,
            paid_at: new Date().toISOString()
        })
        .eq('id', payment.id);

    const { data: campaign } = await supabaseAdmin
        .from('ad_campaigns')
        .select('advertiser_id')
        .eq('id', payment.campaign_id)
        .single();

    if (campaign?.advertiser_id) {
        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('total_spent')
            .eq('id', campaign.advertiser_id)
            .single();

        await supabaseAdmin
            .from('advertisers')
            .update({ total_spent: (advertiser?.total_spent || 0) + payment.amount })
            .eq('id', campaign.advertiser_id);
    }
}

// POST /api/advertiser/payments/paystack/create - Initialize Paystack payment for a campaign
router.post('/paystack/create', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { amount, campaign_id }: CreatePaymentRequest = req.body;

        if (!amount || amount < 10) {
            res.status(400).json({ error: 'Minimum payment amount is 10' });
            return;
        }
        if (!campaign_id) {
            res.status(400).json({ error: 'campaign_id is required' });
            return;
        }

        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('id, email')
            .eq('user_id', req.userId)
            .single();

        if (!advertiser) {
            res.status(404).json({ error: 'Advertiser profile not found' });
            return;
        }

        const { data: campaign } = await supabaseAdmin
            .from('ad_campaigns')
            .select('id, advertiser_id')
            .eq('id', campaign_id)
            .single();

        if (!campaign || campaign.advertiser_id !== advertiser.id) {
            res.status(403).json({ error: 'Campaign not found or not owned by this advertiser' });
            return;
        }

        const reference = `ELXAD_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const { data: payment, error } = await supabaseAdmin
            .from('ad_payments')
            .insert({
                campaign_id,
                amount,
                status: 'pending',
                paystack_reference: reference
            })
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to record payment', details: error.message });
            return;
        }

        const paystackData = await initializeTransaction({
            email: advertiser.email,
            amountSubunit: toSubunit(amount),
            currency: 'KES',
            reference,
            callbackUrl: `${FRONTEND_URL}/advertiser/billing/callback`,
            metadata: {
                advertiser_id: advertiser.id,
                campaign_id,
                payment_id: payment.id
            }
        });

        res.json({
            success: true,
            data: {
                payment_id: payment.id,
                authorization_url: paystackData.authorization_url,
                reference,
                amount
            }
        });
    } catch (error: any) {
        console.error('Paystack create error:', error);
        res.status(500).json({ error: 'Failed to create payment', details: error.message });
    }
});

// GET /api/advertiser/payments/paystack/verify/:reference - Verify Paystack payment
router.get('/paystack/verify/:reference', async (req: Request, res: Response): Promise<void> => {
    try {
        const { reference } = req.params;

        const { data: payment, error: paymentError } = await supabaseAdmin
            .from('ad_payments')
            .select('*')
            .eq('paystack_reference', reference)
            .single();

        if (paymentError || !payment) {
            res.status(404).json({ error: 'Payment not found' });
            return;
        }

        if (payment.status === 'completed') {
            res.json({ success: true, data: { status: 'completed', payment } });
            return;
        }

        const result = await verifyTransaction(reference as string);

        if (result.status === 'success') {
            await applySuccessfulPayment(payment, result.status);
        } else if (result.status === 'failed' || result.status === 'abandoned') {
            await supabaseAdmin
                .from('ad_payments')
                .update({ status: 'failed', paystack_status: result.status })
                .eq('id', payment.id);
        }

        const { data: updatedPayment } = await supabaseAdmin
            .from('ad_payments')
            .select('*')
            .eq('id', payment.id)
            .single();

        res.json({ success: true, data: { status: result.status, payment: updatedPayment } });
    } catch (error: any) {
        console.error('Paystack verify error:', error);
        res.status(500).json({ error: 'Failed to verify payment', details: error.message });
    }
});

// POST /api/advertiser/payments/paystack/webhook - Paystack server-to-server event delivery
router.post('/paystack/webhook', async (req: Request, res: Response): Promise<void> => {
    try {
        const signature = req.headers['x-paystack-signature'] as string | undefined;
        const rawBody = (req as any).rawBody as Buffer | undefined;

        if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        const event = req.body;

        if (event.event === 'charge.success') {
            const reference = event.data.reference;

            const { data: payment } = await supabaseAdmin
                .from('ad_payments')
                .select('*')
                .eq('paystack_reference', reference)
                .single();

            if (payment && payment.status !== 'completed') {
                await applySuccessfulPayment(payment, 'success');
            }

            console.log(`[WEBHOOK] charge.success for ${reference} — ad payment verified`);
        }

        res.json({ received: true });
    } catch (error: any) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// GET /api/advertiser/payments/history - Get payment history across this advertiser's campaigns
router.get('/history', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { page = '1', limit = '10' } = req.query;
        const pageNum = parseInt(page as string, 10);
        const limitNum = parseInt(limit as string, 10);
        const offset = (pageNum - 1) * limitNum;

        const { data: campaigns } = await supabaseAdmin
            .from('ad_campaigns')
            .select('id')
            .eq('advertiser_id', req.advertiserId);

        const campaignIds = (campaigns || []).map((c: any) => c.id);
        if (campaignIds.length === 0) {
            res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, totalPages: 0 } });
            return;
        }

        const { data: payments, error, count } = await supabaseAdmin
            .from('ad_payments')
            .select('*', { count: 'exact' })
            .in('campaign_id', campaignIds)
            .order('created_at', { ascending: false })
            .range(offset, offset + limitNum - 1);

        if (error) {
            res.status(500).json({ error: 'Failed to fetch payments', details: error.message });
            return;
        }

        res.json({
            success: true,
            data: payments,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limitNum)
            }
        });
    } catch (error: any) {
        console.error('Payment history error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
