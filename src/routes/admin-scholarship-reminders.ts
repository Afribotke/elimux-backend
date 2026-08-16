import { Router, Request, Response } from 'express'
import { adminAuth } from '../middleware/auth'
import { sendScholarshipDeadlineReminders } from '../lib/scholarshipReminders'

const router = Router()

/**
 * POST /api/admin/scholarship-applications/send-reminders
 * Manual trigger. Protected by adminAuth (X-Admin-Key). The automated
 * daily trigger runs via /api/cron/scholarship-reminders (CRON_SECRET-gated,
 * called by the scholarship-reminders-cron Railway service) instead - both
 * routes call the same sendScholarshipDeadlineReminders() so they can't
 * diverge in reminder logic or copy.
 */
router.post('/send-reminders', adminAuth, async (req: Request, res: Response) => {
  try {
    const results = await sendScholarshipDeadlineReminders()
    res.json({ success: true, results })
  } catch (error: any) {
    console.error('Reminder cron error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
