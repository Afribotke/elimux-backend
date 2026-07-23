// ============================================================
// ELIMUX 23: Admin Payments Overview (read-only)
// GET /api/admin/payments — combined stats across the two
// existing, separately-billed payment flows:
//   - `payments`    (subscriber subscriptions, routes/payments.ts)
//   - `ad_payments` (advertiser wallet top-ups, routes/advertiser-payments.ts)
// Never returns PAYSTACK_SECRET_KEY — only a derived configured/testMode flag.
// ============================================================

import { Router, Request, Response } from 'express';
import { adminMiddleware } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/', adminMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const [
      { data: subscriptionPayments, error: subError },
      { data: adPayments, error: adError },
    ] = await Promise.all([
      supabase
        .from('payments')
        .select('id, amount, currency, status, payment_method, paystack_reference, created_at, subscriber:subscribers(email)')
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('ad_payments')
        .select('id, amount, status, paystack_reference, paid_at, created_at, advertiser:advertisers(organization_name, email)')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (subError) throw subError;
    if (adError) throw adError;

    const subscriptionRevenue = (subscriptionPayments || [])
      .filter((p: any) => p.status === 'success')
      .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

    const adTopupRevenue = (adPayments || [])
      .filter((p: any) => p.status === 'paid')
      .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

    const [{ count: subTotalCount }, { count: subSuccessCount }, { count: adTotalCount }, { count: adPaidCount }] =
      await Promise.all([
        supabase.from('payments').select('*', { count: 'exact', head: true }),
        supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'success'),
        supabase.from('ad_payments').select('*', { count: 'exact', head: true }),
        supabase.from('ad_payments').select('*', { count: 'exact', head: true }).eq('status', 'paid'),
      ]);

    const secretKey = process.env.PAYSTACK_SECRET_KEY || '';

    res.json({
      success: true,
      data: {
        paystack: {
          configured: secretKey.length > 0,
          testMode: secretKey.startsWith('sk_test_'),
        },
        totals: {
          combined_revenue: subscriptionRevenue + adTopupRevenue,
          subscription_revenue: subscriptionRevenue,
          subscription_transactions: subTotalCount || 0,
          subscription_successful: subSuccessCount || 0,
          ad_topup_revenue: adTopupRevenue,
          ad_topup_transactions: adTotalCount || 0,
          ad_topup_successful: adPaidCount || 0,
        },
        recent_subscription_payments: subscriptionPayments || [],
        recent_ad_payments: adPayments || [],
      },
    });
  } catch (err: any) {
    console.error('Admin payments overview error:', err);
    res.status(500).json({ error: err.message || 'Failed to load payments overview' });
  }
});

export default router;
