import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { adminMiddleware } from '../middleware/auth';

const router = Router();

// Initialize Supabase with service role
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ── HELPER: Normalize company name for URL guessing ──
function normalizeForUrl(name: string): string {
  return name
    .toLowerCase()
    .replace(/(?:limited|ltd|inc|incorporated|plc|llc|corp|corporation|group|holdings)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ── HELPER: Safe URL discovery (HEAD request, no scraping) ──
async function discoverWebsite(name: string): Promise<{ url: string | null; source: string }> {
  const normalized = normalizeForUrl(name);
  if (!normalized) return { url: null, source: 'heuristic' };

  const candidates = [
    `https://www.${normalized}.com`,
    `https://${normalized}.com`,
    `https://www.${normalized}.co.ke`,
    `https://${normalized}.co.ke`,
    `https://www.${normalized}.co.uk`,
    `https://www.${normalized}.org`,
    `https://www.${normalized}.net`,
  ];

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

      // Accept 200-399 status codes
      if (resp.status >= 200 && resp.status < 400) {
        return { url, source: 'heuristic' };
      }
    } catch {
      // Timeout or network error — try next candidate
      continue;
    }
  }

  return { url: null, source: 'heuristic' };
}

// ── POST /api/employer-names/bulk-upload ──
// Admin uploads CSV/array of names
router.post('/bulk-upload', adminMiddleware, async (req, res) => {
  try {
    const { names } = req.body as { names: string[] };
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names array required' });
    }

    // Deduplicate and normalize
    const uniqueNames = [...new Set(names.map(n => n.trim()).filter(n => n.length > 0))];

    const results = [];
    for (const name of uniqueNames) {
      const normalized = normalizeForUrl(name);

      // Skip if already exists
      const { data: existing } = await supabase
        .from('employer_names')
        .select('id')
        .eq('normalized_name', normalized)
        .single();

      if (existing) {
        results.push({ name, status: 'skipped', reason: 'already_exists' });
        continue;
      }

      // Discover website safely
      const { url, source } = await discoverWebsite(name);

      const { data, error } = await supabase
        .from('employer_names')
        .insert({
          name,
          normalized_name: normalized,
          website_url: url,
          discovery_source: source,
          discovery_status: url ? 'found' : 'not_found',
        })
        .select()
        .single();

      if (error) {
        results.push({ name, status: 'error', error: error.message });
      } else {
        results.push({ name, status: 'created', website_url: url, discovery_status: url ? 'found' : 'not_found' });
      }
    }

    return res.json({ success: true, processed: results.length, results });
  } catch (err: any) {
    console.error('[Employer Names Bulk Upload]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/employer-names/search?q=abc ──
// Auto-complete for employer registration (min 3 chars)
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (q.length < 3) {
      return res.status(400).json({ error: 'Query must be at least 3 characters' });
    }

    // Use pg_trgm for fuzzy matching, or ILIKE fallback
    const { data, error } = await supabase
      .from('employer_names')
      .select('id, name, website_url, discovery_status')
      .ilike('name', `%${q}%`)
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
// Get single employer name details
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
// Admin confirms/corrects the discovered website URL
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
