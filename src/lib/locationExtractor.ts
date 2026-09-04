// ============================================================
// elimux-backend/src/lib/locationExtractor.ts
// Extracts a Kenyan county (and, where the alias is town-specific,
// a town label for display) from free-text search queries.
// ============================================================

import { supabase } from './supabase'

export interface ExtractedLocation {
  county?: string
  town?: string
  confidence: 'high' | 'medium' | 'low'
}

// county-level granularity is all `programs.county` is ever backfilled with
// (from institutions.city, which itself is county-level for Kenyan rows) - `town`
// is carried here only for the frontend badge's display text ("Westlands, Nairobi"),
// never used to filter results.
const LOCATION_ALIASES: Record<string, { county: string; town?: string }> = {
  nairobi: { county: 'Nairobi' },
  nrb: { county: 'Nairobi' },
  cbd: { county: 'Nairobi', town: 'Nairobi CBD' },
  westlands: { county: 'Nairobi', town: 'Westlands' },
  kilimani: { county: 'Nairobi', town: 'Kilimani' },
  karen: { county: 'Nairobi', town: 'Karen' },
  eastleigh: { county: 'Nairobi', town: 'Eastleigh' },
  kibera: { county: 'Nairobi', town: 'Kibera' },
  umoja: { county: 'Nairobi', town: 'Umoja' },
  donholm: { county: 'Nairobi', town: 'Donholm' },
  kayole: { county: 'Nairobi', town: 'Kayole' },
  pipeline: { county: 'Nairobi', town: 'Pipeline' },
  kasarani: { county: 'Nairobi', town: 'Kasarani' },
  ruiru: { county: 'Kiambu', town: 'Ruiru' },
  juja: { county: 'Kiambu', town: 'Juja' },
  thika: { county: 'Kiambu', town: 'Thika' },
  kikuyu: { county: 'Kiambu', town: 'Kikuyu' },
  limuru: { county: 'Kiambu', town: 'Limuru' },
  kabete: { county: 'Kiambu', town: 'Kabete' },
  mombasa: { county: 'Mombasa' },
  msa: { county: 'Mombasa' },
  nyali: { county: 'Mombasa', town: 'Nyali' },
  bamburi: { county: 'Mombasa', town: 'Bamburi' },
  kisauni: { county: 'Mombasa', town: 'Kisauni' },
  likoni: { county: 'Mombasa', town: 'Likoni' },
  kisumu: { county: 'Kisumu' },
  ksm: { county: 'Kisumu' },
  ahero: { county: 'Kisumu', town: 'Ahero' },
  muhoroni: { county: 'Kisumu', town: 'Muhoroni' },
  sondu: { county: 'Kisumu', town: 'Sondu' },
  nakuru: { county: 'Nakuru' },
  nax: { county: 'Nakuru' },
  naivasha: { county: 'Nakuru', town: 'Naivasha' },
  gilgil: { county: 'Nakuru', town: 'Gilgil' },
  eldoret: { county: 'Uasin Gishu', town: 'Eldoret' },
  eld: { county: 'Uasin Gishu', town: 'Eldoret' },
  machakos: { county: 'Machakos', town: 'Machakos' },
  athiriver: { county: 'Machakos', town: 'Athi River' },
  'athi river': { county: 'Machakos', town: 'Athi River' },
  syokimau: { county: 'Machakos', town: 'Syokimau' },
  mlolongo: { county: 'Machakos', town: 'Mlolongo' },
  kitengela: { county: 'Kajiado', town: 'Kitengela' },
  ongata: { county: 'Kajiado', town: 'Ongata Rongai' },
  'ongata rongai': { county: 'Kajiado', town: 'Ongata Rongai' },
  rongai: { county: 'Kajiado', town: 'Ongata Rongai' },
  ngong: { county: 'Kajiado', town: 'Ngong' },
  kajiado: { county: 'Kajiado', town: 'Kajiado' },
  kakamega: { county: 'Kakamega', town: 'Kakamega' },
  mumias: { county: 'Kakamega', town: 'Mumias' },
  butere: { county: 'Kakamega', town: 'Butere' },
  bungoma: { county: 'Bungoma', town: 'Bungoma' },
  webuye: { county: 'Bungoma', town: 'Webuye' },
  kimilili: { county: 'Bungoma', town: 'Kimilili' },
  busia: { county: 'Busia', town: 'Busia' },
  siaya: { county: 'Siaya', town: 'Siaya' },
  bondo: { county: 'Siaya', town: 'Bondo' },
  vihiga: { county: 'Vihiga', town: 'Vihiga' },
  luanda: { county: 'Vihiga', town: 'Luanda' },
  homabay: { county: 'Homa Bay', town: 'Homa Bay' },
  'homa bay': { county: 'Homa Bay', town: 'Homa Bay' },
  migori: { county: 'Migori', town: 'Migori' },
  rongo: { county: 'Migori', town: 'Rongo' },
  awendo: { county: 'Migori', town: 'Awendo' },
  nyamira: { county: 'Nyamira', town: 'Nyamira' },
  kisii: { county: 'Kisii', town: 'Kisii' },
  ogembo: { county: 'Kisii', town: 'Ogembo' },
  bomet: { county: 'Bomet', town: 'Bomet' },
  kericho: { county: 'Kericho', town: 'Kericho' },
  kapsabet: { county: 'Nandi', town: 'Kapsabet' },
  kitale: { county: 'Trans Nzoia', town: 'Kitale' },
  kapenguria: { county: 'West Pokot', town: 'Kapenguria' },
  lodwar: { county: 'Turkana', town: 'Lodwar' },
  maralal: { county: 'Samburu', town: 'Maralal' },
  nanyuki: { county: 'Laikipia', town: 'Nanyuki' },
  nyahururu: { county: 'Laikipia', town: 'Nyahururu' },
  kabarnet: { county: 'Baringo', town: 'Kabarnet' },
  iten: { county: 'Elgeyo Marakwet', town: 'Iten' },
  narok: { county: 'Narok', town: 'Narok' },
  kilgoris: { county: 'Narok', town: 'Kilgoris' },
  nyeri: { county: 'Nyeri', town: 'Nyeri' },
  karatina: { county: 'Nyeri', town: 'Karatina' },
  othaya: { county: 'Nyeri', town: 'Othaya' },
  embu: { county: 'Embu', town: 'Embu' },
  runyenjes: { county: 'Embu', town: 'Runyenjes' },
  meru: { county: 'Meru', town: 'Meru' },
  nkubu: { county: 'Meru', town: 'Nkubu' },
  maua: { county: 'Meru', town: 'Maua' },
  muranga: { county: 'Muranga', town: 'Muranga' },
  kangema: { county: 'Muranga', town: 'Kangema' },
  kerugoya: { county: 'Kirinyaga', town: 'Kerugoya' },
  kutus: { county: 'Kirinyaga', town: 'Kutus' },
  wote: { county: 'Makueni', town: 'Wote' },
  kitui: { county: 'Kitui', town: 'Kitui' },
  mwingi: { county: 'Kitui', town: 'Mwingi' },
  makueni: { county: 'Makueni', town: 'Makueni' },
  kilifi: { county: 'Kilifi', town: 'Kilifi' },
  malindi: { county: 'Kilifi', town: 'Malindi' },
  watamu: { county: 'Kilifi', town: 'Watamu' },
  kwale: { county: 'Kwale', town: 'Kwale' },
  ukunda: { county: 'Kwale', town: 'Ukunda' },
  diani: { county: 'Kwale', town: 'Ukunda' },
  voi: { county: 'Taita Taveta', town: 'Voi' },
  wundanyi: { county: 'Taita Taveta', town: 'Wundanyi' },
  taveta: { county: 'Taita Taveta', town: 'Taveta' },
  lamu: { county: 'Lamu', town: 'Lamu' },
  hola: { county: 'Tana River', town: 'Hola' },
  garissa: { county: 'Garissa', town: 'Garissa' },
  wajir: { county: 'Wajir', town: 'Wajir' },
  mandera: { county: 'Mandera', town: 'Mandera' },
  marsabit: { county: 'Marsabit', town: 'Marsabit' },
  moyale: { county: 'Marsabit', town: 'Moyale' },
  isiolo: { county: 'Isiolo', town: 'Isiolo' },
}

export async function extractLocationFromQuery(query: string): Promise<ExtractedLocation | null> {
  if (!query || query.trim().length < 2) return null

  const normalized = query.toLowerCase().trim()
  const words = normalized.split(/\s+/)

  // Strategy 1: hardcoded alias map (fastest, no DB call)
  for (const [alias, mapping] of Object.entries(LOCATION_ALIASES)) {
    const regex = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (regex.test(normalized)) {
      return { county: mapping.county, town: mapping.town, confidence: 'high' }
    }
  }

  // Strategy 2: database fuzzy lookup against kenya_locations, for constituencies/towns
  // not in the hardcoded map above.
  try {
    const { data: townMatch } = await supabase
      .from('kenya_locations')
      .select('county_name, town_name')
      .ilike('town_name', `%${normalized}%`)
      .limit(1)
      .maybeSingle()

    if (townMatch?.town_name) {
      return { county: townMatch.county_name, town: townMatch.town_name, confidence: 'high' }
    }

    for (const word of words) {
      if (word.length < 3) continue

      const { data: matches } = await supabase
        .from('kenya_locations')
        .select('county_name, town_name')
        .or(`county_name.ilike.%${word}%,town_name.ilike.%${word}%`)
        .limit(5)

      if (matches && matches.length > 0) {
        const townHit = matches.find((m) => m.town_name?.toLowerCase() === word)
        if (townHit) {
          return { county: townHit.county_name, town: townHit.town_name, confidence: 'high' }
        }
        return {
          county: matches[0].county_name,
          town: matches[0].town_name || undefined,
          confidence: 'medium',
        }
      }
    }
  } catch (err) {
    console.error('Location extraction DB error:', err)
  }

  return null
}

// True when `word` (a single keyword token, case-insensitive) is itself a
// location alias key or matches the given location's county/town - used to drop
// stray location terms out of the LLM's extracted keyword list before it's used
// for name/description matching, so "Nairobi" doesn't get searched for inside
// program names.
export function isLocationTerm(word: string, location: ExtractedLocation | null): boolean {
  const w = word.toLowerCase()
  if (w in LOCATION_ALIASES) return true
  if (!location) return false
  return w === location.county?.toLowerCase() || w === location.town?.toLowerCase()
}
