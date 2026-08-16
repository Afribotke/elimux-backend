import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '../middleware/auth';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

function toTitleCase(name: string): string {
  const minorWords = new Set(['and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'by', 'a', 'an', 'the', 'with']);
  const alwaysUpper = new Set(['epz', 'ltd', 'llc', 'plc', 'inc', 'corp', 'co', 'llp', 'kg', 'gmbh', 'sa', 'bv', 'nv']);
  return name.toLowerCase().split(/\s+/).map((word, i) => {
    const clean = word.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (alwaysUpper.has(clean)) return word.toUpperCase();
    if (i > 0 && minorWords.has(clean)) return clean;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

function normalizeForUrl(name: string): string {
  return name.toLowerCase()
    .replace(/\b(?:limited|ltd|inc|incorporated|plc|llc|corp|corporation|group|holdings)\b/gi, '')
    .replace(/[^a-z0-9]/g, '').trim();
}

// ── POST /api/employer-names/bulk-upload ──
// FAST: No HTTP calls, just insert names. Returns in seconds even for 3000 names.
router.post('/bulk-upload', adminAuth, async (req, res) => {
  try {
    const { names } = req.body as { names: string[] };
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ error: 'names array required' });
    }

    const rawNames = [...new Set(names.map(n => n.trim()).filter(n => n.length > 0))];
    const total = rawNames.length;
    const results = [];
    let created = 0, skipped = 0, errors = 0;

    for (const rawName of rawNames) {
      const normalizedName = toTitleCase(rawName);
      const normalizedKey = normalizeForUrl(rawName);

      const { data: existing } = await supabase
        .from('employer_names')
        .select('id')
        .eq('normalized_name', normalizedKey)
        .single();

      if (existing) {
        skipped++;
        results.push({ name: normalizedName, status: 'skipped', reason: 'already_exists' });
        continue;
      }

      const { error } = await supabase.from('employer_names').insert({
        name: normalizedName,
        normalized_name: normalizedKey,
        verification_status: 'unverified',
      });

      if (error) {
        errors++;
        results.push({ name: normalizedName, status: 'error', error: error.message });
      } else {
        created++;
        results.push({ name: normalizedName, status: 'created' });
      }
    }

    return res.json({ success: true, total, created, skipped, errors, results });
  } catch (err: any) {
    console.error('[Employer Names Bulk Upload]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/employer-names/:id/discover-url ──
// SEPARATE: Discover URL for a single employer (admin-triggered, one at a time)
router.post('/:id/discover-url', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: employer, error: fetchError } = await supabase
      .from('employer_names')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !employer) {
      return res.status(404).json({ error: 'Employer not found' });
    }

    // Simple URL discovery
    const normalized = normalizeForUrl(employer.name);
    let foundUrl: string | null = null;

    if (normalized) {
      const candidates = [
        `https://www.${normalized}.com`,
        `https://${normalized}.com`,
        `https://www.${normalized}.co.ke`,
        `https://${normalized}.co.ke`,
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
          if (resp.status >= 200 && resp.status < 400) {
            foundUrl = url;
            break;
          }
        } catch { continue; }
      }
    }

    const { data, error } = await supabase
      .from('employer_names')
      .update({
        suggested_website_url: foundUrl,
        discovery_source: foundUrl ? 'heuristic' : null,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      data,
      discovered: !!foundUrl,
      url: foundUrl,
      note: 'URL is a suggestion only — employer must verify during registration'
    });
  } catch (err: any) {
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

    const { data, error } = await supabase
      .from('employer_names')
      .select('id, name, suggested_website_url, verified_website_url, verification_status')
      .ilike('name', `%${q}%`)
      .eq('is_active', true)
      .limit(10);

    if (error) {
      console.error('[Employer Names Search]', error);
      return res.status(500).json({ error: 'Search failed' });
    }

    return res.json({ data: data || [] });
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /api/employer-names/:id/verify ──
// Admin-only: sets the publicly-displayed URL for an employer entry. No
// employer-facing auth exists yet in this codebase — opening this up to
// unauthenticated callers would let anyone set the public-facing URL on any
// row by ID.
router.patch('/:id/verify', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { website_url } = req.body;

    if (!website_url || !website_url.match(/^https?:\/\/.+/)) {
      return res.status(400).json({ error: 'Valid website URL required' });
    }

    const { data, error } = await supabase
      .from('employer_names')
      .update({
        verified_website_url: website_url,
        verification_status: 'verified',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ data, message: 'Website URL verified successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
