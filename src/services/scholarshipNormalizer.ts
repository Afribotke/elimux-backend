export function normalizeCoverageType(raw: string | null | undefined): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase().trim()

  const fullKeywords = ['full', '100%', 'complete', 'entire', 'whole', 'all expenses', 'full ride', 'fully funded']
  const partialKeywords = ['partial', 'half', 'tuition only', 'part', 'some', 'portion', 'percentage']
  const stipendKeywords = ['stipend', 'allowance', 'living', 'monthly', 'per month', 'upkeep', 'maintenance']
  const variableKeywords = ['variable', 'depend', 'case', 'vary', 'based on', 'according to', 'determined by']

  if (fullKeywords.some(k => lower.includes(k))) return 'full'
  if (partialKeywords.some(k => lower.includes(k))) return 'partial'
  if (stipendKeywords.some(k => lower.includes(k))) return 'stipend'
  if (variableKeywords.some(k => lower.includes(k))) return 'variable'
  if (lower.includes('tuition')) return 'partial'

  return null
}

export function parseDeadline(deadlineText: string | null | undefined): { date: string | null; error: string | null } {
  if (!deadlineText || deadlineText.trim() === '') {
    return { date: null, error: 'No deadline provided' }
  }

  const text = deadlineText.trim()

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) {
    const d = new Date(text)
    if (!isNaN(d.getTime())) {
      return { date: d.toISOString(), error: null }
    }
  }

  const dmyMatch = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/)
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch
    const d = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T23:59:59Z`)
    if (!isNaN(d.getTime())) {
      return { date: d.toISOString(), error: null }
    }
  }

  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

  const mdyMatch = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i)
  if (mdyMatch) {
    const monthIdx = monthNames.indexOf(mdyMatch[1].toLowerCase())
    const d = new Date(parseInt(mdyMatch[3]), monthIdx, parseInt(mdyMatch[2]), 23, 59, 59)
    if (!isNaN(d.getTime())) return { date: d.toISOString(), error: null }
  }

  const dmyWordMatch = text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
  if (dmyWordMatch) {
    const monthIdx = monthNames.indexOf(dmyWordMatch[2].toLowerCase())
    const d = new Date(parseInt(dmyWordMatch[3]), monthIdx, parseInt(dmyWordMatch[1]), 23, 59, 59)
    if (!isNaN(d.getTime())) return { date: d.toISOString(), error: null }
  }

  const ordinalMatch = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
  if (ordinalMatch) {
    const monthIdx = monthNames.indexOf(ordinalMatch[2].toLowerCase())
    const d = new Date(parseInt(ordinalMatch[3]), monthIdx, parseInt(ordinalMatch[1]), 23, 59, 59)
    if (!isNaN(d.getTime())) return { date: d.toISOString(), error: null }
  }

  if (/\b(rolling|ongoing|continuous|open until|while funds|as soon as|early|late)\b/i.test(text)) {
    return { date: null, error: `Relative deadline not parseable: "${text}"` }
  }

  return { date: null, error: `Unrecognized deadline format: "${text}"` }
}
