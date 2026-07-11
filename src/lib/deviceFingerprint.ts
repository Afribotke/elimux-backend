import crypto from 'crypto'

export function getDeviceFingerprint(req: any): string {
  const forwardedFor = req.headers['x-forwarded-for']
  const ip = typeof forwardedFor === 'string'
    ? forwardedFor.split(',')[0].trim()
    : req.socket.remoteAddress || 'unknown'
  const ua = req.headers['user-agent'] || 'unknown'
  return crypto.createHash('sha256').update(`${ip}:${ua}`).digest('hex').substring(0, 32)
}
