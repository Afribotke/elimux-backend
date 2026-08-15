import { supabase } from './supabase'
import { sendEmail, deadlineReminderEmailHtml, deadlineReminderSubject } from './email'

export const REMINDER_WINDOWS = [30, 14, 7, 3, 1]

export interface ReminderResults {
  sent: number
  failed: number
  skipped: number
  errors: string[]
}

// Shared by the admin-triggered route (admin-scholarship-reminders.ts) and
// the Railway-cron route (cron-scholarship-reminders.ts) so the two trigger
// paths can never drift into sending different reminder copy or applying
// different dedup/window logic.
export async function sendScholarshipDeadlineReminders(): Promise<ReminderResults> {
  const results: ReminderResults = { sent: 0, failed: 0, skipped: 0, errors: [] }

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

  return results
}
