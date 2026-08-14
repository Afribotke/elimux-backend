import { aiClient } from '../lib/ai-gateway'

// lib/ai-gateway is deliberately admin-key-gated everywhere else in this
// codebase (see routes/ai.ts's own comment: it "proxies paid, per-token LLM
// calls - leaving it public would let anyone run up the bill for free").
// This is the first student-facing caller, so it needs its own limit rather
// than relying on requireUser alone (any logged-in student, no cap). No
// shared rate-limit middleware exists yet in this codebase; this is a
// deliberately minimal in-memory stopgap, not meant to be a hard security
// boundary - it resets on redeploy/restart, which is acceptable for a soft
// per-user cost guard.
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX_CALLS = 10
const callLog = new Map<string, number[]>()

export function checkGuidanceRateLimit(userId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now()
  const calls = (callLog.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS)

  if (calls.length >= RATE_LIMIT_MAX_CALLS) {
    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (now - calls[0])
    callLog.set(userId, calls)
    return { allowed: false, retryAfterMs }
  }

  calls.push(now)
  callLog.set(userId, calls)
  return { allowed: true }
}

export async function getApplicationGuidance(application: any, scholarship: any): Promise<string> {
  const missing: string[] = application.missing_documents || []
  const uploaded: { name: string }[] = application.documents_uploaded || []
  const deadline = scholarship.application_deadline

  let userPrompt = `A student is applying for "${scholarship.title}" (${scholarship.provider}).`

  if (deadline) {
    const daysLeft = Math.ceil((new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    userPrompt += ` Deadline is in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
  }

  userPrompt += `\n\nUploaded documents: ${uploaded.map(d => d.name).join(', ') || 'None'}`
  userPrompt += `\nMissing required documents: ${missing.join(', ') || 'None'}\n\n`

  if (missing.length > 0) {
    userPrompt += 'For each missing document, give specific advice: where to get it, expected processing time, and common mistakes to avoid.'
  } else {
    userPrompt += 'All required documents are uploaded. Give a final pre-submission checklist: what to review, formatting suggestions, and what happens after submission.'
  }

  const result = await aiClient.chat({
    messages: [
      {
        role: 'system',
        content: 'You are a scholarship application advisor for Kenyan students. Be specific and actionable, not generic. Keep the response under 300 words.',
      },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.5,
  })

  return result.content || 'Guidance unavailable — please try again shortly.'
}
