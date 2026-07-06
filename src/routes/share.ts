import { Router } from 'express'
import { supabase } from '../lib/supabase'

const router = Router()

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://v2.elimux.ke'
const API_URL = process.env.API_URL || 'https://api.elimux.ke'

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

    // No per-item detail page exists yet in the static-export frontend
    // (only /programs and /institutions list pages) - route there for now.
    const redirectUrl = shareData.item_type === 'program'
      ? `${FRONTEND_URL.replace(/\/$/, '')}/programs/`
      : `${FRONTEND_URL.replace(/\/$/, '')}/institutions/`

    res.redirect(redirectUrl)
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
