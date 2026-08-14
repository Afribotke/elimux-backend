// Thin wrapper over the Resend HTTP API — no SDK dependency.
// No-ops (logs and returns) when RESEND_API_KEY isn't configured, so this
// is safe to call unconditionally from payment success paths.

const RESEND_API_URL = 'https://api.resend.com/emails'
const FROM_ADDRESS = process.env.RECEIPTS_FROM_EMAIL || 'ElimuX <receipts@elimux.ke>'

// Resend rate-limits at 2 req/s and can return transient 5xx. A receipt is
// worth a few retries, but never worth failing the payment it belongs to —
// every path here swallows the error and returns.
const MAX_ATTEMPTS = 3
const BACKOFF_MS = [500, 1500]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

interface SendEmailParams {
  to: string
  subject: string
  html: string
}

export async function sendEmail({ to, subject, html }: SendEmailParams): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.log(`[EMAIL] RESEND_API_KEY not set — skipping email to ${to} (${subject})`)
    return false
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
      })

      if (res.ok) {
        if (attempt > 1) console.log(`[EMAIL] Sent to ${to} on attempt ${attempt}`)
        return true
      }

      const body = await res.text()

      if (!isRetryable(res.status) || attempt === MAX_ATTEMPTS) {
        console.error(`[EMAIL] Resend request failed (${res.status}) after ${attempt} attempt(s): ${body}`)
        return false
      }

      console.warn(`[EMAIL] Resend ${res.status} on attempt ${attempt}, retrying: ${body}`)
    } catch (error: any) {
      if (attempt === MAX_ATTEMPTS) {
        console.error(`[EMAIL] Failed to send email after ${attempt} attempt(s):`, error.message)
        return false
      }
      console.warn(`[EMAIL] Network error on attempt ${attempt}, retrying:`, error.message)
    }

    await sleep(BACKOFF_MS[attempt - 1])
  }

  return false
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function receiptEmailHtml(params: {
  recipientName: string | null
  description: string
  amount: number
  currency: string
  reference: string
  receiptUrl: string
}): string {
  const { recipientName, description, amount, currency, reference, receiptUrl } = params
  return `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h1 style="font-size: 20px; color: #111;">Thank you${recipientName ? `, ${recipientName}` : ''}!</h1>
      <p style="color: #444; font-size: 14px;">Your payment was received successfully.</p>
      <table style="width: 100%; margin: 16px 0; font-size: 14px; color: #333;">
        <tr><td style="padding: 4px 0; color: #777;">Description</td><td style="text-align: right;">${description}</td></tr>
        <tr><td style="padding: 4px 0; color: #777;">Amount</td><td style="text-align: right; font-weight: 600;">${money(amount, currency)}</td></tr>
        <tr><td style="padding: 4px 0; color: #777;">Reference</td><td style="text-align: right;">${reference}</td></tr>
      </table>
      <a href="${receiptUrl}" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600;">View Receipt</a>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">ElimuX &middot; support@elimux.ke</p>
    </div>
  `
}

export function receiptEmailSubject(reference: string): string {
  return `Your ElimuX Receipt #${reference}`
}

// ── Application Status Notifications ──

export function applicationApprovedEmailHtml({ institutionName, adminNotes }: { institutionName: string; adminNotes?: string }): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="color: #eab308; margin-bottom: 16px;">Application Approved 🎉</h2>
      <p>Congratulations! Your application for <strong>${institutionName}</strong> has been approved on ElimuX.</p>
      ${adminNotes ? `<div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 12px; margin: 16px 0;"><strong>Note from admin:</strong> ${adminNotes}</div>` : ''}
      <p style="margin-top: 24px;">You can now log in to your institution dashboard to manage your programs and listings.</p>
      <a href="https://www.elimux.ke/institution/login" style="display: inline-block; background: #eab308; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-top: 16px;">Go to Dashboard</a>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">ElimuX &middot; support@elimux.ke</p>
    </div>
  `
}

export function applicationApprovedEmailSubject(institutionName: string): string {
  return `Your application for ${institutionName} has been approved`
}

export function applicationRejectedEmailHtml({ institutionName, adminNotes }: { institutionName: string; adminNotes?: string }): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="color: #dc2626; margin-bottom: 16px;">Application Update</h2>
      <p>We regret to inform you that your application for <strong>${institutionName}</strong> has not been approved at this time.</p>
      ${adminNotes ? `<div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px; margin: 16px 0;"><strong>Reason:</strong> ${adminNotes}</div>` : ''}
      <p style="margin-top: 24px;">If you believe this was an error or have questions, please contact our support team.</p>
      <a href="https://www.elimux.ke/contact" style="display: inline-block; background: #eab308; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-top: 16px;">Contact Support</a>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">ElimuX &middot; support@elimux.ke</p>
    </div>
  `
}

export function applicationRejectedEmailSubject(institutionName: string): string {
  return `Update on your application for ${institutionName}`
}

// ── Scholarship Deadline Reminders ──

export function deadlineReminderEmailHtml(
  studentName: string,
  scholarshipTitle: string,
  daysLeft: number,
  deadline: string,
  applicationUrl: string
): string {
  const urgencyColor = daysLeft <= 3 ? '#dc2626' : daysLeft <= 7 ? '#d97706' : '#2563eb'
  const urgencyText = daysLeft <= 3 ? 'URGENT' : daysLeft <= 7 ? 'Important' : 'Reminder'

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="background: ${urgencyColor}; color: white; padding: 16px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 18px;">⏰ ${urgencyText}: Scholarship Deadline</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #374151;">Hi ${studentName},</p>
        <p style="font-size: 16px; color: #374151;">
          Your application for <strong>${scholarshipTitle}</strong> is due in
          <strong style="color: ${urgencyColor}; font-size: 20px;">${daysLeft} days</strong>
          (${deadline}).
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${applicationUrl}"
             style="display: inline-block; background: ${urgencyColor}; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
            Continue Application →
          </a>
        </div>
        <p style="font-size: 14px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 16px;">
          You're receiving this because you started tracking this scholarship on ElimuX.
          <a href="https://elimux.ke/applications" style="color: #2563eb;">Manage your applications</a>
        </p>
      </div>
    </div>
  `
}

export function deadlineReminderSubject(scholarshipTitle: string, daysLeft: number): string {
  return `⏰ ${daysLeft} days left: ${scholarshipTitle}`
}
