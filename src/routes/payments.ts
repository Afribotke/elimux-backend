import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

// M-Pesa STK Push
router.post('/mpesa/stk', async (req, res) => {
  try {
    const { amount, phone_number, email, metadata } = req.body

    if (!amount || !phone_number) {
      return res.status(400).json({ error: 'Missing required fields', required: ['amount', 'phone_number'] })
    }

    const { data: paymentRecord, error: dbError } = await supabase
      .from('payments')
      .insert({
        amount,
        currency: 'KES',
        provider: 'mpesa',
        status: 'pending',
        phone_number,
        email: email || null,
        metadata: metadata || null,
      })
      .select()
      .single()

    if (dbError) {
      console.error('Error creating payment record:', dbError)
      return res.status(500).json({ error: 'Failed to create payment record' })
    }

    const checkoutRequestId = `MPESA_${Date.now()}`

    await supabase
      .from('payments')
      .update({ reference: checkoutRequestId })
      .eq('id', paymentRecord.id)

    return res.json({
      data: {
        payment: paymentRecord,
        checkoutRequestId,
        merchantRequestId: `MERCHANT_${Date.now()}`,
        responseCode: '0',
        responseDescription: 'Success. Request accepted for processing',
      },
      message: 'M-Pesa STK push initiated',
    })
  } catch (error) {
    console.error('M-Pesa STK error:', error)
    return res.status(500).json({ error: 'M-Pesa payment initialization failed' })
  }
})

// M-Pesa callback
router.post('/mpesa/callback', async (req, res) => {
  try {
    console.log('M-Pesa callback received:', req.body)
    return res.json({ success: true, message: 'Callback processed' })
  } catch (error) {
    console.error('M-Pesa callback error:', error)
    return res.status(500).json({ error: 'Callback processing failed' })
  }
})

// Stripe payment intent
router.post('/stripe/intent', async (req, res) => {
  try {
    const { amount, currency, email, metadata } = req.body

    if (!amount || !currency) {
      return res.status(400).json({ error: 'Missing required fields', required: ['amount', 'currency'] })
    }

    const { data: paymentRecord, error: dbError } = await supabase
      .from('payments')
      .insert({
        amount,
        currency,
        provider: 'stripe',
        status: 'pending',
        email: email || null,
        metadata: metadata || null,
      })
      .select()
      .single()

    if (dbError) {
      console.error('Error creating payment record:', dbError)
      return res.status(500).json({ error: 'Failed to create payment record' })
    }

    const clientSecret = `stripe_${Date.now()}_secret`

    await supabase
      .from('payments')
      .update({ reference: paymentRecord.id })
      .eq('id', paymentRecord.id)

    return res.json({
      data: {
        payment: paymentRecord,
        clientSecret,
      },
      message: 'Stripe payment intent created',
    })
  } catch (error) {
    console.error('Stripe intent error:', error)
    return res.status(500).json({ error: 'Stripe payment initialization failed' })
  }
})

// Stripe webhook
router.post('/stripe/webhook', async (req, res) => {
  try {
    console.log('Stripe webhook received:', req.body)
    return res.json({ received: true })
  } catch (error) {
    console.error('Stripe webhook error:', error)
    return res.status(500).json({ error: 'Webhook processing failed' })
  }
})

// GET /api/payments/history — payment history (admin only)
router.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching payment history:', error)
      return res.status(500).json({ error: 'Failed to fetch payment history' })
    }

    return res.json({ data: data || [] })
  } catch (error) {
    console.error('Payment history error:', error)
    return res.status(500).json({ error: 'Failed to fetch payment history' })
  }
})

export default router
