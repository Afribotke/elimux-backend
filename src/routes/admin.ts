import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/admin/verify - lightweight key check the frontend's admin gate
// calls before showing the dashboard. Reuses the same check every other
// admin-protected route already applies, so a key that passes here is
// guaranteed to also work for real CRUD operations (and vice versa).
router.get('/verify', adminMiddleware, (req, res) => {
  res.json({ valid: true })
})

// GET /api/admin/plans — list all plans, including inactive, with active subscriber counts
router.get('/plans', adminMiddleware, async (req, res) => {
  try {
    const { data: plans, error } = await supabase
      .from('subscription_plans')
      .select('*')
      .order('price_kes', { ascending: true })

    if (error) throw error

    const withCounts = await Promise.all(
      (plans || []).map(async (plan) => {
        const { count } = await supabase
          .from('subscriptions')
          .select('*', { count: 'exact', head: true })
          .eq('plan_id', plan.id)
          .eq('status', 'active')

        return { ...plan, subscriber_count: count || 0 }
      })
    )

    res.json({ data: withCounts })
  } catch (error: any) {
    console.error('List admin plans error:', error)
    res.status(500).json({ error: 'Failed to fetch plans' })
  }
})

// POST /api/admin/plans — create a new plan
router.post('/plans', adminMiddleware, async (req, res) => {
  try {
    const { name, slug, description, price_kes, price_usd, currency, duration_months, features, is_active } = req.body

    if (!name || !slug || price_kes === undefined || price_kes === null) {
      return res.status(400).json({ error: 'Missing required fields', required: ['name', 'slug', 'price_kes'] })
    }

    const { data, error } = await supabase
      .from('subscription_plans')
      .insert({
        name,
        slug,
        description: description || null,
        price_kes: Number(price_kes),
        price_usd: price_usd !== undefined && price_usd !== null && price_usd !== '' ? Number(price_usd) : null,
        currency: currency || 'KES',
        duration_months: duration_months ? Number(duration_months) : 1,
        features: features ?? null,
        is_active: is_active ?? true,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating plan:', error)
      return res.status(500).json({ error: 'Failed to create plan', details: error.message })
    }

    res.status(201).json({ data, message: 'Plan created successfully' })
  } catch (error: any) {
    console.error('Create plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/admin/plans/:id — update plan details
router.put('/plans/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params
    const { name, slug, description, price_kes, price_usd, currency, duration_months, features, is_active } = req.body

    const updates: Record<string, unknown> = {}
    if (name !== undefined) updates.name = name
    if (slug !== undefined) updates.slug = slug
    if (description !== undefined) updates.description = description
    if (price_kes !== undefined) updates.price_kes = Number(price_kes)
    if (price_usd !== undefined) updates.price_usd = price_usd === null || price_usd === '' ? null : Number(price_usd)
    if (currency !== undefined) updates.currency = currency
    if (duration_months !== undefined) updates.duration_months = Number(duration_months)
    if (features !== undefined) updates.features = features
    if (is_active !== undefined) updates.is_active = is_active

    const { data, error } = await supabase
      .from('subscription_plans')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating plan:', error)
      return res.status(500).json({ error: 'Failed to update plan', details: error.message })
    }

    res.json({ data, message: 'Plan updated successfully' })
  } catch (error: any) {
    console.error('Update plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/admin/plans/:id — soft delete (is_active = false)
router.delete('/plans/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('subscription_plans')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error deactivating plan:', error)
      return res.status(500).json({ error: 'Failed to deactivate plan', details: error.message })
    }

    res.json({ data, message: 'Plan deactivated successfully' })
  } catch (error: any) {
    console.error('Deactivate plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
