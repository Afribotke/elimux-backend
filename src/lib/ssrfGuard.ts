import dns from 'dns'
import { promisify } from 'util'

const dnsLookup = promisify(dns.lookup)

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1'])

// Optional allowlist - if set, only these domains (and their subdomains) are
// ever fetchable, on top of the IP checks below. Empty = IP/protocol checks
// only. Set via SCRAPER_ALLOWED_DOMAINS="example.ac.ke,another.edu" on Railway.
const ALLOWED_DOMAINS: string[] = (process.env.SCRAPER_ALLOWED_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean)

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
}

// Private/reserved IPv4 ranges - includes 169.254.0.0/16 deliberately, since
// that's the cloud metadata endpoint range (169.254.169.254 on AWS/GCP/Azure/
// Railway) - the single most common real-world SSRF target, not just a
// theoretical "private network" concern.
const PRIVATE_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast and above
]

function isPrivateIPv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip)
  return PRIVATE_IPV4_RANGES.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
    return (ipInt & mask) === (ipv4ToInt(base) & mask)
  })
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') || // unique local fc00::/7
    lower.startsWith('fd') ||
    lower.startsWith('fe8') || // link-local fe80::/10
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('::ffff:') // IPv4-mapped - the embedded v4 address is what actually matters, treat conservatively as private
  )
}

export interface UrlValidationResult {
  valid: boolean
  reason?: string
  resolvedIp?: string
}

// Validates a scraper-supplied URL before it's ever fetched: protocol
// whitelist, hostname blocklist, optional domain allowlist, and a DNS lookup
// checked against private/reserved IP ranges. The DNS check matters because
// the common real SSRF vector isn't a literal "http://127.0.0.1" (obviously
// suspicious) but an innocuous-looking hostname that resolves to an internal
// address - so the resolved IP is what gets checked, not just the literal URL.
export async function validateScraperUrl(urlString: string): Promise<UrlValidationResult> {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    return { valid: false, reason: 'Invalid URL' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only http/https URLs are allowed' }
  }

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, reason: 'Localhost/loopback URLs are not allowed' }
  }

  if (ALLOWED_DOMAINS.length > 0) {
    const allowed = ALLOWED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))
    if (!allowed) {
      return { valid: false, reason: `Domain "${hostname}" is not in the scraper allowlist` }
    }
  }

  let resolved: { address: string; family: number }
  try {
    resolved = await dnsLookup(hostname)
  } catch {
    return { valid: false, reason: 'Could not resolve hostname' }
  }

  const isPrivate = resolved.family === 4 ? isPrivateIPv4(resolved.address) : isPrivateIPv6(resolved.address)
  if (isPrivate) {
    return { valid: false, reason: `Resolved to a private/reserved IP (${resolved.address})`, resolvedIp: resolved.address }
  }

  return { valid: true, resolvedIp: resolved.address }
}
