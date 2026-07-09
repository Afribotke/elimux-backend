import crypto from 'crypto'

const PAYSTACK_BASE_URL = 'https://api.paystack.co'

function getSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY
  if (!key) throw new Error('PAYSTACK_SECRET_KEY is not configured')
  return key
}

async function paystackRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  const body = (await res.json()) as { status: boolean; message?: string; data?: T }

  if (!res.ok || body.status === false) {
    throw new Error(body.message || `Paystack request failed (${res.status})`)
  }

  return body.data as T
}

export interface InitializeTransactionParams {
  email: string
  amountSubunit: number
  currency: string
  reference: string
  callbackUrl: string
  metadata?: Record<string, unknown>
}

export interface InitializeTransactionResult {
  authorization_url: string
  access_code: string
  reference: string
}

export function initializeTransaction(params: InitializeTransactionParams) {
  return paystackRequest<InitializeTransactionResult>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: params.email,
      amount: params.amountSubunit,
      currency: params.currency,
      reference: params.reference,
      callback_url: params.callbackUrl,
      channels: ['card', 'mobile_money', 'bank_transfer', 'ussd'],
      metadata: params.metadata || {},
    }),
  })
}

export interface VerifyTransactionResult {
  status: 'success' | 'failed' | 'abandoned'
  reference: string
  amount: number
  currency: string
  channel: string
  id: number
  customer: { email: string; customer_code: string }
  metadata: Record<string, unknown>
}

export function verifyTransaction(reference: string) {
  return paystackRequest<VerifyTransactionResult>(`/transaction/verify/${encodeURIComponent(reference)}`)
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false
  const hash = crypto.createHmac('sha512', getSecretKey()).update(rawBody).digest('hex')
  return hash === signature
}

// Paystack amounts are in the smallest currency subunit (KES -> cents).
export function toSubunit(amountMajorUnit: number): number {
  return Math.round(amountMajorUnit * 100)
}
