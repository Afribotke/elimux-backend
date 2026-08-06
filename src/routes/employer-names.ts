import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { adminMiddleware } from '../middleware/auth';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ── Words to ignore when building abbreviations ──
// Kept to legal-entity suffixes and grammatical connectors only. Anything
// broader (sector words like "power", "authority", "revenue") strips out
// exactly the letters real acronyms are built from — e.g. "Kenya Revenue
// Authority" needs "revenue" and "authority" to produce "KRA".
const IGNORE_WORDS = new Set([
  'limited', 'ltd', 'inc', 'incorporated', 'plc', 'llc', 'corp', 'corporation',
  'group', 'holdings', 'company', 'co', 'llp',
  'and', 'or', 'of', 'the', 'for', 'in', 'on', 'at', 'to', 'by', 'with', 'a', 'an',
]);

// ── Extract abbreviation from organization name ──
// "Kenya Revenue Authority" → "KRA"
// "Kenya Power & Lighting Company" → "KPL" (generic suffixes like "Company" are dropped,
//   so this is a best-effort heuristic — it won't always match the official acronym)
// "Del Monte Kenya" → "DMK"
function extractAbbreviation(name: string): string | null {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s&]/g, '') // Remove punctuation except &
    .split(/[\s&]+/)               // Split on spaces and &
    .filter(w => w.length > 0 && !IGNORE_WORDS.has(w));

  if (words.length < 2) return null;

  // Take first letter of each significant word
  const acronym = words.map(w => w[0].toUpperCase()).join('');

  // Only return if it's a reasonable acronym (2-6 chars)
  return acronym.length >= 2 && acronym.length <= 6 ? acronym : null;
}

// ── Title Case Normalizer ──
function toTitleCase(name: string): string {
  const minorWords = new Set(['and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'by', 'a', 'an', 'the', 'with']);
  const alwaysUpper = new Set(['epz', 'ltd', 'llc', 'plc', 'inc', 'corp', 'co', 'llp', 'kg', 'gmbh', 'sa', 'bv', 'nv', 'go', 'ke', 'or', 'ac']);

  return name
    .toLowerCase()
    .split(/\s+/)
    .map((word, i) => {
      const clean = word.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (alwaysUpper.has(clean)) return word.toUpperCase();
      if (i > 0 && minorWords.has(clean)) return clean;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

// ── Normalize for URL guessing ──
function normalizeForUrl(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(?:limited|ltd|inc|incorporated|plc|llc|corp|corporation|group|holdings)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ── Smart URL discovery with abbreviations ──
async function discoverWebsite(name: string, abbreviation: string | null): Promise<{ url: string | null; source: string; abbreviation: string | null }> {
  const normalized = normalizeForUrl(name);

  // Build candidate list
  const candidates: string[] = [];

  // 1. Try abbreviation-based URLs first (most likely for gov/orgs)
  if (abbreviation) {
    candidates.push(
      `https://www.${abbreviation.toLowerCase()}.go.ke`,
      `https://${abbreviation.toLowerCase()}.go.ke`,
      `https://www.${abbreviation.toLowerCase()}.or.ke`,
      `https://${abbreviation.toLowerCase()}.or.ke`,
      `https://www.${abbreviation.toLowerCase()}.ac.ke`,
      `https://${abbreviation.toLowerCase()}.ac.ke`,
      `https://www.${abbreviation.toLowerCase()}.com`,
      `https://${abbreviation.toLowerCase()}.com`,
      `https://www.${abbreviation.toLowerCase()}.co.ke`,
      `https://${abbreviation.toLowerCase()}.co.ke`,
    );
  }

  // 2. Try full name-based URLs
  if (normalized) {
    candidates.push(
      `https://www.${normalized}.com`,
      `https://${normalized}.com`,
      `https://www.${normalized}.co.ke`,
      `https://${normalized}.co.ke`,
      `https://www.${normalized}.co.uk`,
      `https://www.${normalized}.org`,
      `https://www.${normalized}.net`,
      `https://www.${normalized}.go.ke`,
      `https://www.${normalized}.or.ke`,
    );
  }

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'ElimuX-Bot/1.0 (+https://www.elimux.ke)' }
      });
      clearTimeout(timeout);

      if (resp.status >= 200 && resp.status < 400) {
        return { url, source: 'heuristic', abbreviation };
      }
    } catch {
      continue;
    }
  }

  return { url: null, source: 'heuristic', abbreviation };
}

// ── POST /api/employer-names/bulk-upload ──
router.post('/bulk-upload', adminMiddleware, async (req, res) => {
  try {
    const { names } = req.body as { names: string[] };
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names array required' });
    }

    const rawNames = [...new Set(names.map(n => n.trim()).filter(n => n.length > 0))];
    const total = rawNames.length;
    const results = [];
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const rawName of rawNames) {
      const normalizedName = toTitleCase(rawName);
      const normalizedKey = normalizeForUrl(rawName);
      const abbreviation = extractAbbreviation(rawName);

      // Skip if already exists
      const { data: existing } = await supabase
        .from('employer_names')
        .select('id')
        .eq('normalized_name', normalizedKey)
        .single();

      if (existing) {
        skipped++;
        results.push({ name: normalizedName, status: 'skipped', reason: 'already_exists', abbreviation });
        continue;
      }

      // Discover website with abbreviation support
      const { url, source, abbreviation: usedAbbr } = await discoverWebsite(rawName, abbreviation);

      const { error } = await supabase
        .from('employer_names')
        .insert({
          name: normalizedName,
          normalized_name: normalizedKey,
          abbreviation: usedAbbr,
          website_url: url,
          discovery_source: source,
          discovery_status: url ? 'found' : 'not_found',
        });

      if (error) {
        errors++;
        results.push({ name: normalizedName, status: 'error', error: error.message, abbreviation: usedAbbr });
      } else {
        created++;
        results.push({
          name: normalizedName,
          status: 'created',
          website_url: url,
          discovery_status: url ? 'found' : 'not_found',
          abbreviation: usedAbbr
        });
      }
    }

    return res.json({
      success: true,
      total,
      created,
      skipped,
      errors,
      results,
    });
  } catch (err: any) {
    console.error('[Employer Names Bulk Upload]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/employer-names/search?q=abc ──
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (q.length < 3) {
      return res.status(400).json({ error: 'Query must be at least 3 characters' });
    }

    // Search by name OR abbreviation
    const { data, error } = await supabase
      .from('employer_names')
      .select('id, name, abbreviation, website_url, discovery_status')
      .or(`name.ilike.%${q}%,abbreviation.ilike.%${q}%`)
      .eq('is_active', true)
      .limit(10);

    if (error) {
      console.error('[Employer Names Search]', error);
      return res.status(500).json({ error: 'Search failed' });
    }

    return res.json({ data: data || [] });
  } catch (err: any) {
    console.error('[Employer Names Search]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/employer-names/:id ──
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('employer_names')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Not found' });
    }

    return res.json({ data });
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/employer-names/:id/verify ──
router.patch('/:id/verify', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { website_url } = req.body;

    const { data, error } = await supabase
      .from('employer_names')
      .update({
        website_url: website_url || null,
        discovery_status: 'verified',
        discovery_source: 'manual',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ data });
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
