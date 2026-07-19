// Scrapes each institution's own website for a logo image and writes it to
// institutions.logo_url, tagging logo_source='scraped'.
//
// Only ever touches rows where logo_source IS NULL — manual overrides
// (logo_source='manual') and institution self-service uploads
// (logo_source='institution_upload') are never selected or written to.
//
// Usage:
//   railway run -- node scripts/fetch_logos.js --dry-run --limit=20
//   railway run -- node scripts/fetch_logos.js --limit=100
//   railway run -- node scripts/fetch_logos.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 10000;
const USER_AGENT = 'ElimuXLogoBot/1.0 (+https://www.elimux.ke)';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const domainMismatches = [];

function normalizeHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// Attribute-order-agnostic tag scanner: pulls every <tagName ...> occurrence
// and returns its attributes as a lowercase-keyed dict.
function parseTags(html, tagName) {
  const tagRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  const attrRe = /([a-zA-Z0-9-:]+)\s*=\s*"([^"]*)"|([a-zA-Z0-9-:]+)\s*=\s*'([^']*)'/g;
  const tags = html.match(tagRe) || [];
  return tags.map((tag) => {
    const attrs = {};
    let m;
    attrRe.lastIndex = 0;
    while ((m = attrRe.exec(tag))) {
      const name = (m[1] || m[3]).toLowerCase();
      const value = m[2] !== undefined ? m[2] : m[4];
      attrs[name] = value;
    }
    return attrs;
  });
}

// Ordered by how reliably each signal points at an actual logo mark
// (vs. a generic social-preview banner photo).
function findLogoCandidates(html) {
  const candidates = [];

  for (const img of parseTags(html, 'img')) {
    const hint = `${img.class || ''} ${img.id || ''} ${img.alt || ''}`.toLowerCase();
    if (img.src && /logo/.test(hint) && !/\blogout\b/.test(hint)) {
      candidates.push({ url: img.src, method: 'img[logo]' });
    }
  }

  for (const link of parseTags(html, 'link')) {
    const rel = (link.rel || '').toLowerCase();
    if (link.href && rel.includes('apple-touch-icon')) {
      candidates.push({ url: link.href, method: `link[${rel}]` });
    }
  }

  for (const meta of parseTags(html, 'meta')) {
    const prop = (meta.property || meta.name || '').toLowerCase();
    if (meta.content && (prop === 'og:image' || prop === 'twitter:image')) {
      candidates.push({ url: meta.content, method: `meta[${prop}]` });
    }
  }

  for (const link of parseTags(html, 'link')) {
    const rel = (link.rel || '').toLowerCase();
    if (link.href && (rel === 'icon' || rel === 'shortcut icon')) {
      candidates.push({ url: link.href, method: `link[${rel}]` });
    }
  }

  return candidates;
}

async function verifyImageUrl(url) {
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    let contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.startsWith('image/')) {
      res = await fetchWithTimeout(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT } });
      res.body?.cancel?.();
      contentType = res.headers.get('content-type') || '';
    }
    return res.ok && contentType.startsWith('image/');
  } catch {
    return false;
  }
}

async function resolveLogoForInstitution(inst) {
  let pageUrl;
  try {
    pageUrl = /^https?:\/\//i.test(inst.website_url) ? inst.website_url : `https://${inst.website_url}`;
    new URL(pageUrl);
  } catch {
    return { ok: false, reason: 'invalid website_url' };
  }

  let html;
  let finalPageUrl = pageUrl;
  try {
    const res = await fetchWithTimeout(pageUrl, { method: 'GET', headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { ok: false, reason: `homepage HTTP ${res.status}` };
    finalPageUrl = res.url || pageUrl;
    html = await res.text();

    const origHost = normalizeHost(inst.website_url);
    const finalHost = normalizeHost(finalPageUrl);
    if (origHost && finalHost && origHost !== finalHost) {
      domainMismatches.push({ id: inst.id, name: inst.name, from: origHost, to: finalHost });
      console.log(`  [domain-mismatch] ${inst.name}: ${origHost} -> ${finalHost} (logo kept)`);
    }
  } catch (e) {
    return { ok: false, reason: `homepage fetch failed: ${e.message}` };
  }

  const candidates = findLogoCandidates(html);
  candidates.push({ url: '/favicon.ico', method: 'default[/favicon.ico]' });

  for (const c of candidates) {
    if (c.url.startsWith('data:')) continue;
    let abs;
    try {
      abs = new URL(c.url, finalPageUrl).href;
    } catch {
      continue;
    }
    if (await verifyImageUrl(abs)) {
      return { ok: true, url: abs, method: c.method };
    }
  }

  return { ok: false, reason: 'no valid logo candidate found' };
}

async function runPool(items, worker, concurrency) {
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
}

async function main() {
  console.log(`fetch_logos.js starting${DRY_RUN ? ' (DRY RUN — no writes)' : ''}${LIMIT ? ` limit=${LIMIT}` : ''}`);

  let query = supabase
    .from('institutions')
    .select('id, name, website_url')
    .eq('is_active', true)
    .is('logo_source', null)
    .not('website_url', 'is', null)
    .order('id', { ascending: true });

  if (LIMIT) query = query.limit(LIMIT);

  const { data: institutions, error } = await query;
  if (error) {
    console.error('Failed to fetch institutions:', error.message);
    process.exit(1);
  }

  console.log(`Found ${institutions.length} candidate institution(s) (logo_source IS NULL, website_url present).`);

  let scraped = 0;
  let failed = 0;
  let done = 0;

  await runPool(
    institutions,
    async (inst) => {
      const result = await resolveLogoForInstitution(inst);
      done++;
      const prefix = `[${done}/${institutions.length}] ${inst.name}`;

      if (result.ok) {
        scraped++;
        console.log(`${prefix} -> FOUND ${result.url} (${result.method})`);
        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from('institutions')
            .update({ logo_url: result.url, logo_source: 'scraped' })
            .eq('id', inst.id)
            .is('logo_source', null); // never clobber a row tagged by anything else in the meantime
          if (updateError) {
            console.error(`${prefix} -> DB WRITE FAILED: ${updateError.message}`);
          }
        }
      } else {
        failed++;
        console.log(`${prefix} -> FAILED (${result.reason})`);
      }
    },
    CONCURRENCY
  );

  console.log('---');
  console.log(
    `Done. scraped=${scraped} failed=${failed} total=${institutions.length}${DRY_RUN ? ' (dry run, no writes made)' : ''}`
  );

  if (domainMismatches.length) {
    console.log(`\nDomain mismatches (${domainMismatches.length}) — logo kept, institution data flagged for review:`);
    for (const m of domainMismatches) console.log(`  ${m.id} | ${m.name} | ${m.from} -> ${m.to}`);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
