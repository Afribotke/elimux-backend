import { createHmac } from 'crypto';

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

if (!PAYSTACK_SECRET) {
  console.error('[Paystack] PAYSTACK_SECRET_KEY missing. Disbursement disabled.');
}

async function paystackRequest<T>(path: string, options: RequestInit = {}): Promise<{ status: boolean; message?: string; data: T }> {
  const url = `${PAYSTACK_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${PAYSTACK_SECRET}`,
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, { ...options, headers });
  const data = (await response.json()) as { status: boolean; message?: string; data: T };

  if (!response.ok) {
    throw new Error(`Paystack API error: ${data.message || response.statusText}`);
  }

  return data;
}

interface PaystackRecipient {
  recipient_code: string;
  id: number;
  type: string;
  name: string;
  details?: { account_number?: string; bank_code?: string };
}

interface PaystackTransfer {
  transfer_code: string;
  id: number;
  amount: number;
  reference: string;
  status: string;
}

interface PaystackTransferStatus {
  status: string;
  amount: number;
  recipient: unknown;
  created_at: string;
  paid_at?: string;
}

// Create a transfer recipient (M-Pesa mobile money or bank)
export async function createRecipient(
  name: string,
  phoneNumber: string,
  accountNumber?: string,
  bankCode?: string
) {
  const isMobileMoney = !bankCode || bankCode === 'MPESA';

  const payload = {
    type: isMobileMoney ? 'mobile_money' : 'nuban',
    name,
    account_number: isMobileMoney ? phoneNumber : accountNumber,
    bank_code: isMobileMoney ? 'MPESA' : bankCode,
    currency: 'KES',
  };

  const { data } = await paystackRequest<PaystackRecipient>('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return data;
}

// Initiate a transfer
export async function initiateTransfer(
  amount: number,
  recipientCode: string,
  reason: string,
  reference?: string
) {
  const { data } = await paystackRequest<PaystackTransfer>('/transfer', {
    method: 'POST',
    body: JSON.stringify({
      source: 'balance',
      amount: Math.round(amount * 100),
      recipient: recipientCode,
      reason,
      reference: reference || `BURSARY_${Date.now()}`,
    }),
  });

  return data;
}

// Verify a transfer status
export async function verifyTransfer(transferCode: string) {
  const { data } = await paystackRequest<PaystackTransferStatus>(`/transfer/${transferCode}`);
  return data;
}

// Parse Paystack webhook payload
export function parseWebhookEvent(payload: any) {
  const event = payload.event;
  const data = payload.data;

  return {
    event,
    transferCode: data?.transfer_code,
    reference: data?.reference,
    status: data?.status,
    amount: data?.amount ? data.amount / 100 : 0,
    recipient: data?.recipient,
    reason: data?.reason,
    createdAt: data?.created_at,
    paidAt: data?.paid_at,
    failedAt: data?.failed_at,
  };
}

// Verify webhook signature. Takes the raw request body Buffer, not a
// re-serialized JSON.stringify(req.body) - the app-wide express.json()
// verify callback in index.ts already stashes this on (req as any).rawBody
// for exactly this reason (JSON.stringify can reorder keys/whitespace
// relative to what Paystack actually signed, silently breaking every real
// webhook). Matches the same Buffer-based signature the existing, working
// lib/paystack.ts's verifyWebhookSignature() uses.
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!PAYSTACK_SECRET || !signature) return false;
  const hash = createHmac('sha512', PAYSTACK_SECRET).update(rawBody).digest('hex');
  return hash === signature;
}

// Normalize Kenyan phone number
export function normalizePhone(phone: string): string {
  let normalized = phone.replace(/\D/g, '');
  if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
  if (!normalized.startsWith('254') || normalized.length !== 12) {
    throw new Error('Invalid phone. Use 07XX XXX XXX or 2547XX XXX XXX');
  }
  return normalized;
}
