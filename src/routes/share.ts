import { Router } from 'express'
import { randomBytes } from 'crypto'
import { supabase } from '../lib/supabase'

const router = Router()

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://v2.elimux.ke'
const API_URL = process.env.API_URL || 'https://api.elimux.ke'

// POST /api/share/search - share a set of programs (search results or a
// comparison) as a single link, e.g. a student sending their shortlist to a
// parent. Distinct from POST /api/share below, which shares one program or
// institution and redirects straight to its detail page.
router.post('/search', async (req, res) => {
  try {
    const { program_ids, query, email } = req.body || {}

    if (!Array.isArray(program_ids) || program_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'program_ids (non-empty array) required' })
    }

    const { data: programs, error: programsError } = await supabase
      .from('programs')
      .select('id, name, duration_months, tuition_fees, currency, level, mode, institution:institutions(name, city, country:countries(name))')
      .in('id', program_ids)

    if (programsError) throw programsError

    const token = randomBytes(16).toString('hex')

    const { data, error } = await supabase
      .from('shared_searches')
      .insert({
        share_token: token,
        user_email: email || null,
        query_text: query || null,
        programs: programs || [],
      })
      .select()
      .single()

    if (error) throw error

    const shareUrl = `${FRONTEND_URL.replace(/\/$/, '')}/share/?token=${data.share_token}`

    res.status(201).json({ success: true, token: data.share_token, shareUrl })
  } catch (error: any) {
    console.error('Share search error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// GET /api/share/search/:token - read back a shared search (JSON, not a
// redirect - the frontend /share page renders this itself).
router.get('/search/:token', async (req, res) => {
  try {
    const { token } = req.params

    const { data: shared, error: sharedError } = await supabase
      .from('shared_searches')
      .select('*')
      .eq('share_token', token)
      .single()

    if (sharedError || !shared) {
      return res.status(404).json({ success: false, error: 'Shared search not found' })
    }

    await supabase
      .from('shared_searches')
      .update({ view_count: (shared.view_count || 0) + 1, last_viewed_at: new Date().toISOString() })
      .eq('share_token', token)

    res.json({ success: true, data: shared })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.post('/', async (req, res) => {
  try {
    const { item_id, item_type } = req.body

    if (!item_id || !item_type) {
      return res.status(400).json({ success: false, error: 'item_id and item_type required' })
    }

    const { data, error } = await supabase
      .from('share_links')
      .insert({ item_id, item_type, click_count: 0 })
      .select()
      .single()

    if (error) throw error

    const shareUrl = `${API_URL.replace(/\/$/, '')}/api/share/${data.id}`

    res.status(201).json({ success: true, data: { share_id: data.id, share_url: shareUrl } })
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const { data: shareData, error: shareError } = await supabase
      .from('share_links')
      .select('*')
      .eq('id', id)
      .single()

    if (shareError || !shareData) {
      return res.status(404).json({ success: false, error: 'Share link not found' })
    }

    await supabase
      .from('share_links')
      .update({ click_count: (shareData.click_count || 0) + 1 })
      .eq('id', id)

    const redirectUrl = shareData.item_type === 'program'
      ? `${FRONTEND_URL.replace(/\/$/, '')}/programs/${shareData.item_id}/`
      : `${FRONTEND_URL.replace(/\/$/, '')}/institutions/${shareData.item_id}/`

    res.redirect(redirectUrl)
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
