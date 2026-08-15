import { Router, Request, Response } from 'express'
import { sendScholarshipDeadlineReminders } from '../lib/scholarshipReminders'

const router = Router()

/**
 * POST /api/cron/scholarship-reminders
 * Triggered by the scholarship-reminders-cron Railway service. Gated on a
 * dedicated CRON_SECRET (not the admin key) so the cron container's config
 * doesn't need admin-level credentials.
 */
router.post('/', async (req: Request, res: Response) => {
  const cronSecret = req.headers['x-cron-secret']
  if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid cron secret' })
  }

  try {
    const results = await sendScholarshipDeadlineReminders()
    res.json({ success: true, results, timestamp: new Date().toISOString() })
  } catch (error: any) {
    console.error('Reminder cron error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
