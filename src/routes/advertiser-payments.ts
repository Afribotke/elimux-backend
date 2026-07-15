// ============================================
// ELIMUX AD PORTAL - PAYMENT ROUTES
// ============================================

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { initializeTransaction, verifyTransaction, verifyWebhookSignature, toSubunit } from '../lib/paystack';
import { advertiserAuth, AdvertiserAuthRequest } from '../middleware/advertiser-auth';
import { CreatePaymentRequest, MpesaPaymentRequest } from '../types/advertiser';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.elimux.ke';

async function applySuccessfulTopup(payment: any, transactionId: string): Promise<void> {
    await supabaseAdmin
        .from('ad_payments')
        .update({
            payment_status: 'completed',
            transaction_id: transactionId,
            updated_at: new Date().toISOString()
        })
        .eq('id', payment.id);
}

// POST /api/advertiser/payments/paystack/create - Initialize Paystack top-up
router.post('/paystack/create', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { amount, currency = 'KES', campaign_id }: CreatePaymentRequest = req.body;

        if (!amount || amount < 10) {
            res.status(400).json({ error: 'Minimum top-up amount is 10' });
            return;
        }

        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('id, company_name, company_email')
            .eq('user_id', req.userId)
            .single();

        if (!advertiser) {
            res.status(404).json({ error: 'Advertiser profile not found' });
            return;
        }

        const reference = `ELXAD_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

        const { data: payment, error } = await supabaseAdmin
            .from('ad_payments')
            .insert({
                advertiser_id: advertiser.id,
                campaign_id: campaign_id || null,
                amount: amount,
                currency: currency.toUpperCase(),
                payment_method: 'paystack',
                payment_status: 'pending',
                paystack_reference: reference
            })
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to record payment', details: error.message });
            return;
        }

        const paystackData = await initializeTransaction({
            email: advertiser.company_email,
            amountSubunit: toSubunit(amount),
            currency: currency.toUpperCase(),
            reference,
            callbackUrl: `${FRONTEND_URL}/advertiser/billing/callback`,
            metadata: {
                advertiser_id: advertiser.id,
                payment_id: payment.id,
                type: 'ad_topup'
            }
        });

        res.json({
            success: true,
            data: {
                payment_id: payment.id,
                authorization_url: paystackData.authorization_url,
                reference,
                amount: amount,
                currency: currency.toUpperCase()
            }
        });
    } catch (error: any) {
        console.error('Paystack create error:', error);
        res.status(500).json({ error: 'Failed to create payment', details: error.message });
    }
});

// GET /api/advertiser/payments/paystack/verify/:reference - Verify Paystack top-up
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

        if (payment.payment_status === 'completed') {
            res.json({ success: true, data: { status: 'completed', payment } });
            return;
        }

        const result = await verifyTransaction(reference as string);

        if (result.status === 'success') {
            await applySuccessfulTopup(payment, result.id.toString());
        } else if (result.status === 'failed' || result.status === 'abandoned') {
            await supabaseAdmin
                .from('ad_payments')
                .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
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

            if (payment && payment.payment_status !== 'completed') {
                await applySuccessfulTopup(payment, event.data.id.toString());
            }

            console.log(`[WEBHOOK] charge.success for ${reference} — ad top-up verified`);
        }

        res.json({ received: true });
    } catch (error: any) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// POST /api/advertiser/payments/mpesa/create - Create M-Pesa payment
router.post('/mpesa/create', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { amount, phone_number, campaign_id }: MpesaPaymentRequest = req.body;

        if (!amount || amount < 100) {
            res.status(400).json({ error: 'Minimum top-up amount is KES 100' });
            return;
        }

        if (!phone_number) {
            res.status(400).json({ error: 'phone_number is required for M-Pesa' });
            return;
        }

        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('id')
            .eq('user_id', req.userId)
            .single();

        if (!advertiser) {
            res.status(404).json({ error: 'Advertiser profile not found' });
            return;
        }

        const { data: payment, error } = await supabaseAdmin
            .from('ad_payments')
            .insert({
                advertiser_id: advertiser.id,
                campaign_id: campaign_id || null,
                amount: amount,
                currency: 'KES',
                payment_method: 'mpesa',
                payment_status: 'pending',
                metadata: {
                    mpesa_phone: phone_number
                }
            })
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to create M-Pesa payment', details: error.message });
            return;
        }

        res.json({
            success: true,
            message: 'M-Pesa payment initiated. Check your phone for STK push.',
            data: {
                payment_id: payment.id,
                amount_kes: amount,
                phone_number,
                instructions: 'Pay via M-Pesa STK Push or send to business number. Then confirm with payment_id.'
            }
        });
    } catch (error: any) {
        console.error('M-Pesa create error:', error);
        res.status(500).json({ error: 'Failed to create M-Pesa payment', details: error.message });
    }
});

// POST /api/advertiser/payments/mpesa/confirm - Confirm M-Pesa payment
router.post('/mpesa/confirm', async (req: Request, res: Response): Promise<void> => {
    try {
        const { payment_id, transaction_id } = req.body;

        if (!payment_id) {
            res.status(400).json({ error: 'payment_id is required' });
            return;
        }

        const { data: payment, error } = await supabaseAdmin
            .from('ad_payments')
            .select('*')
            .eq('id', payment_id)
            .eq('payment_method', 'mpesa')
            .eq('payment_status', 'pending')
            .single();

        if (error || !payment) {
            res.status(404).json({ error: 'Payment not found or already processed' });
            return;
        }

        const { data: updatedPayment, error: updateError } = await supabaseAdmin
            .from('ad_payments')
            .update({
                payment_status: 'completed',
                transaction_id: transaction_id || `MPESA-${Date.now()}`,
                updated_at: new Date().toISOString()
            })
            .eq('id', payment.id)
            .select()
            .single();

        if (updateError) {
            res.status(500).json({ error: 'Failed to confirm M-Pesa payment', details: updateError.message });
            return;
        }

        res.json({
            success: true,
            message: 'M-Pesa payment confirmed',
            data: updatedPayment
        });
    } catch (error: any) {
        console.error('M-Pesa confirm error:', error);
        res.status(500).json({ error: 'Failed to confirm M-Pesa payment', details: error.message });
    }
});

// GET /api/advertiser/payments/history - Get payment history
router.get('/history', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { page = '1', limit = '10' } = req.query;
        const pageNum = parseInt(page as string, 10);
        const limitNum = parseInt(limit as string, 10);
        const offset = (pageNum - 1) * limitNum;

        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('id')
            .eq('user_id', req.userId)
            .single();

        if (!advertiser) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }

        const { data: payments, error, count } = await supabaseAdmin
            .from('ad_payments')
            .select('*', { count: 'exact' })
            .eq('advertiser_id', advertiser.id)
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
