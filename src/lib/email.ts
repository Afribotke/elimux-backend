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

// ── Scholarship Application Review Outcomes ──

export function scholarshipAwardedEmailHtml({ studentName, scholarshipTitle, reviewNotes }: { studentName: string; scholarshipTitle: string; reviewNotes?: string }): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="color: #22c55e; margin-bottom: 16px;">Congratulations, ${studentName}! 🎉</h2>
      <p>Your application for <strong>${scholarshipTitle}</strong> has been reviewed and awarded on ElimuX.</p>
      ${reviewNotes ? `<div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 12px; margin: 16px 0;"><strong>Note from the reviewer:</strong> ${reviewNotes}</div>` : ''}
      <p style="margin-top: 24px;">Log in to your ElimuX applications dashboard for the full details.</p>
      <a href="https://www.elimux.ke/applications" style="display: inline-block; background: #22c55e; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-top: 16px;">View Application</a>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">ElimuX &middot; support@elimux.ke</p>
    </div>
  `
}

export function scholarshipAwardedEmailSubject(scholarshipTitle: string): string {
  return `You've been awarded: ${scholarshipTitle}`
}

export function scholarshipRejectedEmailHtml({ studentName, scholarshipTitle, reviewNotes }: { studentName: string; scholarshipTitle: string; reviewNotes?: string }): string {
  return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="color: #dc2626; margin-bottom: 16px;">Application Update</h2>
      <p>Hi ${studentName}, your application for <strong>${scholarshipTitle}</strong> was not successful this time.</p>
      ${reviewNotes ? `<div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 12px; margin: 16px 0;"><strong>Feedback from the reviewer:</strong> ${reviewNotes}</div>` : ''}
      <p style="margin-top: 24px;">Don't be discouraged — browse other scholarships you may qualify for on ElimuX.</p>
      <a href="https://www.elimux.ke/scholarships" style="display: inline-block; background: #eab308; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; margin-top: 16px;">Browse Scholarships</a>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">ElimuX &middot; support@elimux.ke</p>
    </div>
  `
}

export function scholarshipRejectedEmailSubject(scholarshipTitle: string): string {
  return `Update on your application for ${scholarshipTitle}`
}

// ── CRM Templated Email (Cycle 160) ──
// Separate from sendEmail() above deliberately: sendEmail() has 5 existing
// callers relying on its {to,subject,html} -> boolean signature, and this
// path needs the Resend message id + failure reason back for crm_messages
// logging, which a boolean can't carry.

import type { CRMMessageTemplate, CRMContact, CRMContactPerson } from '../types/crm'

interface TemplateVariables {
  contact_name: string
  person_name?: string
  county?: string
  slug?: string
  assigned_rep_name?: string
  elimux_url?: string
  [key: string]: string | undefined
}

function renderTemplate(template: string, variables: TemplateVariables): string {
  let result = template
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value || '')
  }
  return result
}

function injectTrackingPixel(html: string, messageId: string, baseUrl: string): string {
  const pixelUrl = `${baseUrl}/api/crm/track-open?id=${messageId}`
  return html + `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;" />`
}

function wrapLinks(html: string, messageId: string, baseUrl: string): string {
  return html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (_match, url) => `href="${baseUrl}/api/crm/track-click?id=${messageId}&url=${encodeURIComponent(url)}"`
  )
}

interface CrmEmailResult {
  success: boolean
  messageId?: string
  error?: string
}

async function sendCrmEmail(to: string, subject: string, html: string, text: string): Promise<CrmEmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.log(`[EMAIL] RESEND_API_KEY not set — skipping CRM email to ${to} (${subject})`)
    return { success: false, error: 'RESEND_API_KEY not configured' }
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.CRM_FROM_EMAIL || 'ElimuX Partnerships <partnerships@elimux.ke>',
        to,
        subject,
        html,
        text,
      }),
    })

    const data: any = await res.json().catch(() => ({}))

    if (!res.ok) {
      console.error(`[EMAIL] CRM send to ${to} failed (${res.status}):`, data)
      return { success: false, error: data?.message || `Resend API error (${res.status})` }
    }

    return { success: true, messageId: data?.id }
  } catch (error: any) {
    console.error('[EMAIL] CRM send error:', error.message)
    return { success: false, error: error.message || 'Unknown error' }
  }
}

export async function sendTemplatedEmail(
  template: CRMMessageTemplate,
  contact: CRMContact,
  person: CRMContactPerson | null,
  variables: TemplateVariables,
  sentBy: string,
  baseUrl: string,
  supabaseClient: any // pass Supabase client for logging
): Promise<CrmEmailResult> {
  if (!template.channel_email || !template.subject_email || !template.body_html) {
    return { success: false, error: 'Template does not support email channel' }
  }

  const toEmail = person?.email || contact.email
  if (!toEmail) {
    return { success: false, error: 'No email address available' }
  }

  const subject = renderTemplate(template.subject_email, variables)
  let html = renderTemplate(template.body_html, variables)
  const text = renderTemplate(template.body_text || template.body_html, variables)

  const { data: messageLog, error: logError } = await supabaseClient
    .from('crm_messages')
    .insert({
      contact_id: contact.id,
      person_id: person?.id || null,
      template_id: template.id,
      channel: 'email',
      subject,
      body: html,
      status: 'queued',
      sent_by: sentBy,
    })
    .select('id')
    .single()

  if (logError || !messageLog) {
    return { success: false, error: `Failed to create message log: ${logError?.message}` }
  }

  html = injectTrackingPixel(html, messageLog.id, baseUrl)
  html = wrapLinks(html, messageLog.id, baseUrl)

  const result = await sendCrmEmail(toEmail, subject, html, text)

  await supabaseClient
    .from('crm_messages')
    .update({
      status: result.success ? 'sent' : 'failed',
      provider: 'resend',
      provider_msg_id: result.messageId || null,
      sent_at: result.success ? new Date().toISOString() : null,
      failed_at: result.success ? null : new Date().toISOString(),
      fail_reason: result.error || null,
    })
    .eq('id', messageLog.id)

  if (result.success) {
    await supabaseClient
      .from('crm_contacts')
      .update({
        last_contact_at: new Date().toISOString(),
        last_contact_via: 'email',
        contact_count: (contact.contact_count || 0) + 1,
      })
      .eq('id', contact.id)
  }

  return result
}

// ============================================
// CRM SMS — Africa's Talking (appended, not replacing existing exports)
// ============================================

const AT_USERNAME = process.env.AT_USERNAME || process.env.AFRICAS_TALKING_USERNAME || '';
const AT_API_KEY = process.env.AT_API_KEY || process.env.AFRICAS_TALKING_API_KEY || '';
const AT_SENDER_ID = process.env.AT_SENDER_ID || process.env.AFRICAS_TALKING_SENDER || 'ELIMUX';

interface SendSmsOptions {
  to: string;
  message: string;
  from?: string;
}

interface SendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
  costKes?: number;
}

function normalizePhone(phone: string): string {
  // Convert to E.164 for Africa's Talking: +254XXXXXXXXX
  const cleaned = phone.replace(/\s/g, '').replace(/^0/, '+254').replace(/^254/, '+254');
  if (!cleaned.startsWith('+')) {
    return '+254' + cleaned;
  }
  return cleaned;
}

/**
 * WARNING: AT_USERNAME is set to 'sandbox'.
 * Africa's Talking sandbox does NOT deliver to real phone numbers.
 * Only use this for testing with simulator-registered numbers.
 * For real outreach, switch to a production AT account first.
 */
export async function sendSms(options: SendSmsOptions): Promise<SendSmsResult> {
  if (!AT_USERNAME || !AT_API_KEY) {
    console.warn("Africa's Talking credentials not set — SMS not sent");
    return { success: false, error: 'AT_USERNAME or AT_API_KEY not configured' };
  }

  const to = normalizePhone(options.to);
  const message = options.message;
  const from = options.from || AT_SENDER_ID;

  // Africa's Talking charges per SMS segment (160 chars for GSM-7, 70 for Unicode)
  // Approximate cost: KES 0.80 per segment
  const segments = Math.ceil(message.length / 160);
  const costKes = segments * 0.80;

  try {
    const response = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'apiKey': AT_API_KEY,
      },
      body: new URLSearchParams({
        username: AT_USERNAME,
        to: to,
        message: message,
        from: from,
      }).toString(),
    });

    const data: any = await response.json();

    if (!response.ok || data.SMSMessageData?.Recipients?.[0]?.status !== 'Success') {
      const errorMsg = data.SMSMessageData?.Recipients?.[0]?.status ||
                       data.SMSMessageData?.Message ||
                       "Africa's Talking API error";
      console.error('SMS send error:', errorMsg);
      return { success: false, error: errorMsg, costKes: 0 };
    }

    const recipient = data.SMSMessageData.Recipients[0];
    return {
      success: true,
      messageId: recipient.messageId,
      costKes,
    };
  } catch (error) {
    console.error('SMS send exception:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown SMS error',
      costKes: 0,
    };
  }
}

export async function sendTemplatedSms(
  template: any, // CRMMessageTemplate
  contact: any, // CRMContact
  person: any | null, // CRMContactPerson | null
  variables: TemplateVariables,
  sentBy: string,
  supabaseClient: any
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!template.channel_sms || !template.body_sms) {
    return { success: false, error: 'Template does not support SMS channel' };
  }

  const toPhone = person?.phone || contact.phone;
  if (!toPhone) {
    return { success: false, error: 'No phone number available' };
  }

  // Render template
  let body = template.body_sms;
  for (const [key, value] of Object.entries(variables)) {
    body = body.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
  }

  // Create message log
  const { data: messageLog, error: logError } = await supabaseClient
    .from('crm_messages')
    .insert({
      contact_id: contact.id,
      person_id: person?.id || null,
      template_id: template.id,
      channel: 'sms',
      body: body,
      status: 'queued',
      sent_by: sentBy,
    })
    .select('id')
    .single();

  if (logError || !messageLog) {
    return { success: false, error: `Failed to create message log: ${logError?.message}` };
  }

  // Send via Africa's Talking
  const result = await sendSms({ to: toPhone, message: body });

  // Update log
  await supabaseClient
    .from('crm_messages')
    .update({
      status: result.success ? 'sent' : 'failed',
      provider: 'africastalking',
      provider_msg_id: result.messageId || null,
      sent_at: result.success ? new Date().toISOString() : null,
      failed_at: result.success ? null : new Date().toISOString(),
      fail_reason: result.error || null,
      cost_kes: result.costKes || 0,
    })
    .eq('id', messageLog.id);

  // Update contact stats
  if (result.success) {
    await supabaseClient
      .from('crm_contacts')
      .update({
        last_contact_at: new Date().toISOString(),
        last_contact_via: 'sms',
        contact_count: (contact.contact_count || 0) + 1,
      })
      .eq('id', contact.id);
  }

  return { success: result.success, messageId: result.messageId, error: result.error };
}

// Smart channel router: picks best available channel for a contact
export async function sendTemplatedMessage(
  template: any,
  contact: any,
  person: any | null,
  variables: TemplateVariables,
  sentBy: string,
  baseUrl: string,
  supabaseClient: any
): Promise<{ success: boolean; messageId?: string; error?: string; channel?: string }> {
  // Priority: Email (default for now) → SMS (sandbox-only) → WhatsApp (not yet integrated) → enrichment flag

  // 1. Email — primary channel
  const email = person?.email || contact.email;
  if (template.channel_email && email && !contact.unsubscribed_email) {
    const result = await sendTemplatedEmail(template, contact, person, variables, sentBy, baseUrl, supabaseClient);
    return { ...result, channel: 'email' };
  }

  // 2. SMS — sandbox only, not for real outreach yet
  const phone = person?.phone || contact.phone;
  if (template.channel_sms && phone && !contact.unsubscribed_sms) {
    const result = await sendTemplatedSms(template, contact, person, variables, sentBy, supabaseClient);
    return { ...result, channel: 'sms' };
  }

  // 3. WhatsApp — Phase 4, not integrated
  const whatsappNumber = person?.whatsapp || contact.whatsapp_number;
  if (template.channel_whatsapp && whatsappNumber && !contact.unsubscribed_whatsapp) {
    return { success: false, error: 'WhatsApp not yet integrated', channel: 'whatsapp' };
  }

  // Nothing available
  return {
    success: false,
    error: 'No contact channel available. Needs enrichment: add email, phone, or WhatsApp.',
    channel: 'none',
  };
}
