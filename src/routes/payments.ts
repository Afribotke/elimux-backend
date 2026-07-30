import { Router } from 'express'
import crypto from 'crypto'
import { supabase } from '../lib/supabase'
import { initializeTransaction, verifyTransaction, verifyWebhookSignature, toSubunit } from '../lib/paystack'
import { sendEmail, receiptEmailHtml, receiptEmailSubject } from '../lib/email'

const router = Router()

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.elimux.ke'
const PAYMENT_SELECT = '*, subscriber:subscribers(name, email), subscription:subscriptions(*, plan:subscription_plans(*))'

function activePeriodEnd(durationMonths: number): string {
  const end = new Date()
  end.setMonth(end.getMonth() + durationMonths)
  return end.toISOString()
}

async function findOrCreateSubscriber(email: string, name?: string, phone?: string, country?: string) {
  const { data: existing } = await supabase
    .from('subscribers')
    .select('*')
    .eq('email', email)
    .maybeSingle()

  if (existing) return existing

  const { data: created, error } = await supabase
    .from('subscribers')
    .insert({ email, name: name || null, phone: phone || null, country: country || null })
    .select()
    .single()

  if (error) throw error
  return created
}

async function authenticateSubscriber(email: unknown, token: unknown) {
  if (!email || !token) return null
  const { data } = await supabase
    .from('subscribers')
    .select('*')
    .eq('email', email as string)
    .eq('access_token', token as string)
    .maybeSingle()
  return data
}

// GET /api/payments/plans
router.get('/plans', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('is_active', true)
      .order('price_kes', { ascending: true })

    if (error) throw error
    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('List plans error:', error)
    res.status(500).json({ error: 'Failed to fetch plans' })
  }
})

// POST /api/payments/initialize
// body: { email, name?, phone?, country?, plan_id, payment_method? }
router.post('/initialize', async (req, res) => {
  try {
    const { email, name, phone, country, plan_id } = req.body

    if (!email || !plan_id) {
      return res.status(400).json({ error: 'Missing required fields', required: ['email', 'plan_id'] })
    }

    const { data: plan, error: planError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', plan_id)
      .eq('is_active', true)
      .maybeSingle()

    if (planError) throw planError
    if (!plan) return res.status(404).json({ error: 'Plan not found' })

    const subscriber = await findOrCreateSubscriber(email, name, phone, country)

    // Free plan: activate immediately, no Paystack round-trip
    if (plan.price_kes === 0) {
      const { data: subscription, error: subError } = await supabase
        .from('subscriptions')
        .insert({
          subscriber_id: subscriber.id,
          plan_id: plan.id,
          status: 'active',
          current_period_start: new Date().toISOString(),
          current_period_end: activePeriodEnd(plan.duration_months),
        })
        .select()
        .single()

      if (subError) throw subError

      return res.json({
        data: { free: true, subscription, subscriber_email: subscriber.email, access_token: subscriber.access_token },
        message: 'Free plan activated',
      })
    }

    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .insert({
        subscriber_id: subscriber.id,
        plan_id: plan.id,
        status: 'pending',
      })
      .select()
      .single()

    if (subError) throw subError

    const reference = `ELX_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .insert({
        subscriber_id: subscriber.id,
        subscription_id: subscription.id,
        amount: plan.price_kes,
        currency: plan.currency || 'KES',
        paystack_reference: reference,
        status: 'pending',
        metadata: { plan_slug: plan.slug },
      })
      .select()
      .single()

    if (paymentError) throw paymentError

    const paystackData = await initializeTransaction({
      email,
      amountSubunit: toSubunit(plan.price_kes),
      currency: plan.currency || 'KES',
      reference,
      callbackUrl: `${FRONTEND_URL}/payments/callback`,
      metadata: { subscription_id: subscription.id, plan_slug: plan.slug },
    })

    res.json({
      data: {
        authorization_url: paystackData.authorization_url,
        reference,
        payment,
        subscriber_email: subscriber.email,
        access_token: subscriber.access_token,
      },
      message: 'Payment initialized',
    })
  } catch (error: any) {
    console.error('Initialize payment error:', error)
    res.status(500).json({ error: error.message || 'Failed to initialize payment' })
  }
})

// GET /api/payments/verify/:reference
router.get('/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select(PAYMENT_SELECT)
      .eq('paystack_reference', reference)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) return res.status(404).json({ error: 'Payment not found' })

    if (payment.status === 'success') {
      return res.json({ data: { status: 'success', payment } })
    }

    const result = await verifyTransaction(reference)

    if (result.status === 'success') {
      await applySuccessfulPayment(payment, result.id.toString(), result.channel)
    } else if (result.status === 'failed' || result.status === 'abandoned') {
      await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id)
    }

    const { data: updatedPayment } = await supabase
      .from('payments')
      .select(PAYMENT_SELECT)
      .eq('id', payment.id)
      .single()

    res.json({ data: { status: result.status, payment: updatedPayment } })
  } catch (error: any) {
    console.error('Verify payment error:', error)
    res.status(500).json({ error: error.message || 'Failed to verify payment' })
  }
})

// GET /api/payments/receipt/:reference — public, read-only, success payments only
router.get('/receipt/:reference', async (req, res) => {
  try {
    const { reference } = req.params

    const { data: payment, error } = await supabase
      .from('payments')
      .select(PAYMENT_SELECT)
      .eq('paystack_reference', reference)
      .eq('status', 'success')
      .maybeSingle()

    if (error) throw error
    if (!payment) return res.status(404).json({ error: 'Receipt not found' })

    res.json({ data: payment })
  } catch (error: any) {
    console.error('Fetch receipt error:', error)
    res.status(500).json({ error: error.message || 'Failed to fetch receipt' })
  }
})

// POST /api/payments/retry — body: { reference }
// Re-attempts a failed or abandoned payment by opening a fresh Paystack
// transaction against the SAME subscription row. Going back through
// /initialize would insert another subscription on every retry, leaving a
// trail of orphaned 'pending' ones; this reuses the original.
router.post('/retry', async (req, res) => {
  try {
    const { reference } = req.body

    if (!reference) {
      return res.status(400).json({ error: 'Missing required fields', required: ['reference'] })
    }

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select(PAYMENT_SELECT)
      .eq('paystack_reference', reference)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) return res.status(404).json({ error: 'Payment not found' })
    if (payment.status === 'success') {
      return res.status(409).json({ error: 'Payment already completed', reference })
    }

    const plan = payment.subscription?.plan
    const email = payment.subscriber?.email

    if (!plan || !email) {
      return res.status(422).json({ error: 'This payment cannot be retried — start over from the pricing page' })
    }

    // Close out the previous attempt so it can't sit as 'pending' forever.
    if (payment.status === 'pending') {
      await supabase.from('payments').update({ status: 'failed' }).eq('id', payment.id)
    }

    const retryReference = `ELX_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`

    const { data: retryPayment, error: retryError } = await supabase
      .from('payments')
      .insert({
        subscriber_id: payment.subscriber_id,
        subscription_id: payment.subscription_id,
        amount: plan.price_kes,
        currency: plan.currency || 'KES',
        paystack_reference: retryReference,
        status: 'pending',
        metadata: { plan_slug: plan.slug, retry_of: payment.paystack_reference },
      })
      .select()
      .single()

    if (retryError) throw retryError

    const paystackData = await initializeTransaction({
      email,
      amountSubunit: toSubunit(plan.price_kes),
      currency: plan.currency || 'KES',
      reference: retryReference,
      callbackUrl: `${FRONTEND_URL}/payments/callback`,
      metadata: {
        subscription_id: payment.subscription_id,
        plan_slug: plan.slug,
        retry_of: payment.paystack_reference,
      },
    })

    res.json({
      data: {
        authorization_url: paystackData.authorization_url,
        reference: retryReference,
        payment: retryPayment,
      },
      message: 'Payment retry initialized',
    })
  } catch (error: any) {
    console.error('Retry payment error:', error)
    res.status(500).json({ error: error.message || 'Failed to retry payment' })
  }
})

async function applySuccessfulPayment(payment: any, transactionId: string, channel?: string) {
  await supabase
    .from('payments')
    .update({ status: 'success', paystack_transaction_id: transactionId, payment_method: channel || null })
    .eq('id', payment.id)

  if (payment.subscription_id) {
    const plan = payment.subscription?.plan
    const durationMonths = plan?.duration_months || 1

    await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: activePeriodEnd(durationMonths),
      })
      .eq('id', payment.subscription_id)
  }

  const recipientEmail = payment.subscriber?.email
  if (recipientEmail) {
    const planName = payment.subscription?.plan?.name || 'Subscription'
    await sendEmail({
      to: recipientEmail,
      subject: receiptEmailSubject(payment.paystack_reference),
      html: receiptEmailHtml({
        recipientName: payment.subscriber?.name || null,
        description: `ElimuX ${planName} Subscription`,
        amount: payment.amount,
        currency: payment.currency,
        reference: payment.paystack_reference,
        receiptUrl: `${FRONTEND_URL}/receipts/${payment.paystack_reference}`,
      }),
    })
  }
}

// POST /api/payments/webhook — Paystack server-to-server event delivery
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'] as string | undefined
    const rawBody = (req as any).rawBody as Buffer | undefined

    if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' })
    }

    const event = req.body

    if (event.event === 'charge.success') {
      const reference = event.data.reference

      const { data: payment } = await supabase
        .from('payments')
        .select(PAYMENT_SELECT)
        .eq('paystack_reference', reference)
        .maybeSingle()

      if (payment && payment.status !== 'success') {
        await applySuccessfulPayment(payment, event.data.id.toString(), event.data.channel)
      }

      console.log(`[WEBHOOK] charge.success for ${reference} — payment verified`)
    }

    res.json({ received: true })
  } catch (error: any) {
    console.error('Webhook processing error:', error)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

// GET /api/payments/subscription?email=&token= — current subscription status
router.get('/subscription', async (req, res) => {
  try {
    const subscriber = await authenticateSubscriber(req.query.email, req.query.token)
    if (!subscriber) return res.status(401).json({ error: 'Invalid email or access token' })

    const { data, error } = await supabase
      .from('subscriptions')
      .select('*, plan:subscription_plans(*)')
      .eq('subscriber_id', subscriber.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    // Lazy expiry: an active subscription past its period end is expired
    if (data && data.status === 'active' && data.current_period_end && new Date(data.current_period_end).getTime() < Date.now()) {
      await supabase.from('subscriptions').update({ status: 'expired' }).eq('id', data.id)
      data.status = 'expired'
    }

    res.json({ data: data || null })
  } catch (error: any) {
    console.error('Subscription status error:', error)
    res.status(500).json({ error: 'Failed to fetch subscription status' })
  }
})

// POST /api/payments/cancel — body: { email, token, subscription_id }
router.post('/cancel', async (req, res) => {
  try {
    const { email, token, subscription_id } = req.body
    const subscriber = await authenticateSubscriber(email, token)
    if (!subscriber) return res.status(401).json({ error: 'Invalid email or access token' })

    const { data, error } = await supabase
      .from('subscriptions')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', subscription_id)
      .eq('subscriber_id', subscriber.id)
      .select()
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ error: 'Subscription not found' })

    res.json({ data, message: 'Subscription cancelled' })
  } catch (error: any) {
    console.error('Cancel subscription error:', error)
    res.status(500).json({ error: 'Failed to cancel subscription' })
  }
})

// GET /api/payments/history?email=&token=
router.get('/history', async (req, res) => {
  try {
    const subscriber = await authenticateSubscriber(req.query.email, req.query.token)
    if (!subscriber) return res.status(401).json({ error: 'Invalid email or access token' })

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('subscriber_id', subscriber.id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ data: data || [] })
  } catch (error: any) {
    console.error('Payment history error:', error)
    res.status(500).json({ error: 'Failed to fetch payment history' })
  }
})

// ============================================================
// EXPIRY SWEEP — active subscriptions past current_period_end
// become expired. Runs at startup and every 24h; the lazy check
// in GET /subscription covers the gaps between sweeps.
// ============================================================
export async function expireLapsedSubscriptions() {
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .update({ status: 'expired' })
      .eq('status', 'active')
      .lt('current_period_end', new Date().toISOString())
      .select('id')

    if (error) throw error
    if (data && data.length > 0) console.log(`[EXPIRY] Marked ${data.length} subscription(s) expired`)
  } catch (error: any) {
    console.error('Expiry sweep error:', error)
  }
}

expireLapsedSubscriptions()
setInterval(expireLapsedSubscriptions, 24 * 60 * 60 * 1000).unref()

export default router
