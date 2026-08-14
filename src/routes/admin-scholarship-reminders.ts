import { Router, Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { sendEmail, deadlineReminderEmailHtml, deadlineReminderSubject } from '../lib/email'
import { adminMiddleware } from '../middleware/auth'

const router = Router()
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const REMINDER_WINDOWS = [30, 14, 7, 3, 1]

/**
 * POST /api/admin/scholarship-applications/send-reminders
 * Triggered daily by Railway cron. Protected by adminMiddleware (X-Admin-Key).
 */
router.post('/send-reminders', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const results = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] }

    for (const days of REMINDER_WINDOWS) {
      const windowStart = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      const windowEnd = new Date(Date.now() + (days + 1) * 24 * 60 * 60 * 1000).toISOString()

      const { data: scholarships, error: schError } = await supabase
        .from('scholarships')
        .select('id, title, application_deadline, application_url')
        .eq('status', 'active')
        .eq('application_status', 'open')
        .gte('application_deadline', windowStart)
        .lt('application_deadline', windowEnd)

      if (schError) {
        results.errors.push(`Scholarship query (${days}d): ${schError.message}`)
        continue
      }

      if (!scholarships?.length) continue

      for (const s of scholarships) {
        const { data: applications, error: appError } = await supabase
          .from('scholarship_applications')
          .select('id, student_id, status, reminder_dates')
          .eq('scholarship_id', s.id)
          .in('status', ['draft', 'submitted'])

        if (appError) {
          results.errors.push(`Application query (${s.title}): ${appError.message}`)
          continue
        }

        for (const app of applications || []) {
          const reminders = app.reminder_dates || []
          if (reminders.some((r: any) => r.window === days)) {
            results.skipped++
            continue
          }

          const { data: userData, error: userError } = await supabase.auth.admin.getUserById(app.student_id)

          if (userError || !userData?.user?.email) {
            results.skipped++
            continue
          }

          const deadline = new Date(s.application_deadline).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric',
          })

          // sendEmail (lib/email.ts) never throws - it swallows every
          // failure (missing RESEND_API_KEY, non-retryable HTTP error,
          // exhausted retries, network error) and returns false. Checking
          // that return value, not just try/catch, is what actually
          // determines whether the reminder gets marked sent - relying on
          // catch alone would mark every reminder "sent" whether or not an
          // email ever went out, permanently burning that window with no
          // retry possible.
          const sent = await sendEmail({
            to: userData.user.email,
            subject: deadlineReminderSubject(s.title, days),
            html: deadlineReminderEmailHtml(
              userData.user.user_metadata?.full_name || 'there',
              s.title,
              days,
              deadline,
              s.application_url || 'https://elimux.ke/applications'
            ),
          })

          if (!sent) {
            results.failed++
            results.errors.push(`Email to ${userData.user.email} (${s.title}, ${days}d) did not send`)
            continue
          }

          await supabase
            .from('scholarship_applications')
            .update({
              deadline_reminder_sent: true,
              reminder_dates: [...reminders, { window: days, sent_at: new Date().toISOString() }],
            })
            .eq('id', app.id)

          results.sent++
        }
      }
    }

    res.json({ success: true, results })
  } catch (error: any) {
    console.error('Reminder cron error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
