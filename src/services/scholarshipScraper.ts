import * as cheerio from 'cheerio'

export interface ScholarshipExtract {
  title: string
  provider: string
  description: string | null
  eligibility: string | null
  benefits: string | null
  amount: string | null
  currency: string | null
  coverage_type: string | null
  application_deadline: string | null
  application_url: string | null
  required_documents: string[]
  funding_amount: number | null
  duration: number | null
  duration_unit: 'months' | 'years' | 'one_time' | null
}

interface ScrapeResult {
  scholarships: ScholarshipExtract[]
  rawText: string
  confidenceScore: number
}

export async function scrapeScholarshipPage(
  url: string,
  aiExtract: (text: string) => Promise<{ scholarships: any[] }>
): Promise<ScrapeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ElimuX-Bot/1.0 (+https://elimux.ke/bot)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const html = await response.text()
    const $ = cheerio.load(html)

    $('script, style, nav, footer, header, aside, .advertisement, .ads, .sidebar').remove()

    let text = ''
    const contentSelectors = [
      'main', 'article', '.content', '.main-content', '#content',
      '.scholarship-detail', '.program-detail', '.entry-content',
      '[role="main"]', 'body',
    ]

    for (const selector of contentSelectors) {
      const el = $(selector)
      if (el.length > 0) {
        text = el.text()
        if (text.length > 500) break
      }
    }

    if (!text || text.length < 200) {
      text = $('body').text()
    }

    const rawText = text
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim()
      .slice(0, 100000)

    const extracted = await aiExtract(rawText)

    const scholarships: ScholarshipExtract[] = []
    let validCount = 0

    for (const item of extracted.scholarships || []) {
      if (item.title && item.provider) {
        const lowerText = rawText.toLowerCase()
        const titleMatch = lowerText.includes(item.title.toLowerCase())
        const providerMatch = lowerText.includes(item.provider.toLowerCase())

        if (titleMatch && providerMatch) {
          scholarships.push(item)
          validCount++
        }
      }
    }

    const confidenceScore = extracted.scholarships?.length > 0
      ? Math.round((validCount / extracted.scholarships.length) * 100)
      : 0

    return { scholarships, rawText, confidenceScore }
  } catch (error) {
    clearTimeout(timeout)
    throw error
  }
}

export const PHASE_2_SOURCES = [
  { name: 'Equity Wings to Fly', url: 'https://www.equitygroupfoundation.com/wings-to-fly/', type: 'website' as const },
  { name: 'KCB Foundation Scholarships', url: 'https://www.kcbgroup.com/foundation', type: 'website' as const },
  { name: 'Safaricom Foundation', url: 'https://www.safaricomfoundation.org/', type: 'website' as const },
  { name: 'UoN Scholarships', url: 'https://www.uonbi.ac.ke/financial-aid-scholarships', type: 'website' as const },
  { name: 'KU Scholarships', url: 'https://www.ku.ac.ke/financial-aid/', type: 'website' as const },
  { name: 'MKU Scholarships', url: 'https://www.mku.ac.ke/financial-aid/', type: 'website' as const },
  { name: 'Strathmore Scholarships', url: 'https://www.strathmore.edu/financial-aid/', type: 'website' as const },
  { name: 'USIU Scholarships', url: 'https://www.usiu.ac.ke/financial-aid/', type: 'website' as const },
]
