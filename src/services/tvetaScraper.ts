import * as cheerio from 'cheerio'

interface ScrapedInstitution {
  name: string
  registrationNumber: string | null
  category: string | null
  type: string | null
  county: string | null
  status: string
  sourceUrl: string
  rawText: string
}

const USER_AGENT = 'ElimuX-Bot/1.0 (+https://www.elimux.ke) - Educational data aggregation for student protection'
const DELAY_MS = 2500 // respectful delay between requests
const TVETA_BASE = 'https://www.tveta.go.ke'

const KENYA_COUNTIES = [
  'Nairobi', 'Mombasa', 'Kisumu', 'Nakuru', 'Kiambu', 'Kakamega', 'Kericho', 'Kisii', 'Meru', 'Nyeri',
  'Bungoma', 'Busia', 'Embu', 'Garissa', 'Homa Bay', 'Kajiado', 'Kilifi', 'Kirinyaga', 'Kitui', 'Kwale',
  'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera', 'Marsabit', 'Migori', "Murang'a", 'Nandi', 'Narok',
  'Nyamira', 'Nyandarua', 'Samburu', 'Siaya', 'Taita Taveta', 'Tana River', 'Tharaka Nithi', 'Trans Nzoia',
  'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot', 'Baringo', 'Bomet', 'Elgeyo Marakwet',
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Check robots.txt before scraping ──
export async function checkRobotsTxt(): Promise<{ allowed: boolean; rules: string }> {
  try {
    const resp = await fetch(`${TVETA_BASE}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return { allowed: true, rules: 'No robots.txt found' }

    const text = await resp.text()
    const lines = text.split('\n')
    const disallowed = lines.some(
      (l) => l.toLowerCase().startsWith('disallow:') && l.toLowerCase().includes('accredited')
    )

    return { allowed: !disallowed, rules: text.substring(0, 500) }
  } catch {
    return { allowed: true, rules: 'Could not fetch robots.txt' }
  }
}

// ── Scrape a single listing page ──
export async function scrapeTvetaPage(pageUrl: string): Promise<ScrapedInstitution[]> {
  const results: ScrapedInstitution[] = []

  try {
    const resp = await fetch(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${pageUrl}`)

    const html = await resp.text()
    const $ = cheerio.load(html)

    const rows = $('table tbody tr, .institution-list .item, .accredited-item, article')

    rows.each((_, elem) => {
      const $row = $(elem)
      const text = $row.text().trim()
      if (!text || text.length < 5) return

      const regMatch = text.match(/TVETA\/[A-Z]+\/[A-Z]{2}\/\d{4}\/\d{4}/i)
      const registrationNumber = regMatch ? regMatch[0].toUpperCase() : null

      let name = $row.find('strong, b, h3, h4, .title, td:first-child').first().text().trim()
      if (!name) name = text.split('\n')[0].trim()
      if (!name || name.length < 3) return

      let category: string | null = null
      const lower = text.toLowerCase()
      if (lower.includes('national polytechnic')) category = 'National Polytechnic'
      else if (lower.includes('technical vocational college') || lower.includes('tvc')) category = 'Technical Vocational College'
      else if (lower.includes('vocational training centre') || lower.includes('vtc')) category = 'Vocational Training Centre'

      let type: string | null = null
      if (lower.includes('public')) type = 'Public'
      else if (lower.includes('private')) type = 'Private'

      const foundCounty = KENYA_COUNTIES.find((c) => lower.includes(c.toLowerCase()))

      results.push({
        name,
        registrationNumber,
        category,
        type,
        county: foundCounty || null,
        status: 'Active',
        sourceUrl: pageUrl,
        rawText: text.substring(0, 200),
      })
    })

    return results
  } catch (err: any) {
    console.error(`[tvetaScraper] ${pageUrl}:`, err.message)
    return []
  }
}

// ── Discover pagination / category pages ──
export async function discoverPages(startUrl: string): Promise<string[]> {
  const pages: string[] = [startUrl]

  try {
    const resp = await fetch(startUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return pages

    const html = await resp.text()
    const $ = cheerio.load(html)

    $('a').each((_, elem) => {
      const href = $(elem).attr('href')
      if (href && href.includes('accredited') && href.includes('page')) {
        const fullUrl = href.startsWith('http') ? href : `${TVETA_BASE}${href}`
        if (!pages.includes(fullUrl)) pages.push(fullUrl)
      }
    })

    const categoryLinks = [
      '/accredited-tvet-institutions/national-polytechnics/',
      '/accredited-tvet-institutions/technical-vocational-colleges/',
      '/accredited-tvet-institutions/vocational-training-centres/',
    ]
    for (const link of categoryLinks) {
      const fullUrl = `${TVETA_BASE}${link}`
      if (!pages.includes(fullUrl)) pages.push(fullUrl)
    }
  } catch (err: any) {
    console.error('[tvetaScraper] discoverPages:', err.message)
  }

  return pages
}

// ── Main scrape orchestrator ──
export async function runTvetaScrape(): Promise<{
  success: boolean
  pagesScanned: number
  institutions: ScrapedInstitution[]
  errors: string[]
}> {
  const errors: string[] = []

  const robots = await checkRobotsTxt()
  if (!robots.allowed) {
    return { success: false, pagesScanned: 0, institutions: [], errors: ['robots.txt disallows scraping'] }
  }

  const pages = await discoverPages(`${TVETA_BASE}/accredited-tvet-institutions/`)
  console.log(`[tvetaScraper] discovered ${pages.length} pages`)

  const all: ScrapedInstitution[] = []
  for (let i = 0; i < pages.length; i++) {
    console.log(`[tvetaScraper] page ${i + 1}/${pages.length}: ${pages[i]}`)
    all.push(...(await scrapeTvetaPage(pages[i])))
    if (i < pages.length - 1) await delay(DELAY_MS)
  }

  const seen = new Set<string>()
  const unique = all.filter((inst) => {
    const key = inst.registrationNumber || inst.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { success: true, pagesScanned: pages.length, institutions: unique, errors }
}
