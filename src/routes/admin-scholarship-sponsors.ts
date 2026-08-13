import { Router } from 'express'
import { adminMiddleware } from '../middleware/auth'
import { supabase } from '../lib/supabase'

const router = Router()

// GET /api/admin/scholarship-sponsors?type=&country=&search=
router.get('/', adminMiddleware, async (req, res) => {
  try {
    const type = req.query.type as string | undefined
    const country = req.query.country as string | undefined
    const search = ((req.query.search as string) || '').trim()

    let query = supabase
      .from('scholarship_sponsors')
      .select('*', { count: 'exact' })
      .order('name', { ascending: true })

    if (type) query = query.eq('type', type)
    if (country) query = query.eq('country_code', country)
    if (search) query = query.ilike('name', `%${search}%`)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data: data || [], meta: { total: count || 0 } })
  } catch (error: any) {
    console.error('GET /api/admin/scholarship-sponsors error:', error)
    res.status(500).json({ error: error.message || 'Failed to fetch sponsors' })
  }
})

// POST /api/admin/scholarship-sponsors
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const body = req.body || {}

    if (!body.name || !body.type) {
      return res.status(400).json({ error: 'Missing required fields: name, type' })
    }

    const { data, error } = await supabase
      .from('scholarship_sponsors')
      .insert({
        name: body.name,
        type: body.type,
        logo_url: body.logo_url,
        website: body.website,
        country_code: body.country_code,
        contact_email: body.contact_email,
        contact_phone: body.contact_phone,
        description: body.description,
        is_verified: body.is_verified || false,
        tier: body.tier || 'free',
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ data, message: 'Sponsor created successfully' })
  } catch (error: any) {
    console.error('POST /api/admin/scholarship-sponsors error:', error)
    res.status(500).json({ error: error.message || 'Failed to create sponsor' })
  }
})

export default router
