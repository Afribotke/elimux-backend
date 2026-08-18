import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminAuth } from '../middleware/auth';

const router = Router();

// PostgREST filter strings (used by .or()) treat , ( ) as syntax, not data -
// strip them from user-supplied search input so it can't inject additional
// filter clauses or malform the query.
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()]/g, '').trim();
}

// GET /api/admin/bursary-providers
// Protected: super admin only
router.get('/', adminAuth, async (req, res) => {
  const { status = 'pending', page = '1', limit = '20', search } = req.query;
  const pageNum = parseInt(page as string) || 1;
  const limitNum = parseInt(limit as string) || 20;
  const offset = (pageNum - 1) * limitNum;

  let query = supabase
    .from('tenants')
    .select('id, slug, name, type, status, verification_status, contact, registration_number, created_at, updated_at', { count: 'exact' });

  // 'all' has no equivalent tenants.status value - the given filter
  // (.eq('status', status)) would match zero rows for it, breaking the
  // "All" tab Task 3 requires. Only filter by status when a specific one
  // is requested.
  if (status && status !== 'all') {
    query = query.eq('status', status as string);
  }

  const searchTerm = typeof search === 'string' ? sanitizeSearchTerm(search) : '';
  if (searchTerm) {
    query = query.or(`name.ilike.%${searchTerm}%,contact->>email.ilike.%${searchTerm}%`);
  }

  const { data: providers, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    providers: providers || [],
    pagination: {
      page: pageNum,
      limit: limitNum,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limitNum),
    },
  });
});

// GET /api/admin/bursary-providers/:id
// Protected: super admin
router.get('/:id', adminAuth, async (req, res) => {
  const { id } = req.params;

  const { data: provider } = await supabase
    .from('tenants')
    .select('*, tenant_branding(*)')
    .eq('id', id)
    .single();

  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  return res.status(200).json({ provider });
});

// PATCH /api/admin/bursary-providers/:id/approve
// Protected: super admin
router.patch('/:id/approve', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { notes } = req.body;

  const { data: provider, error } = await supabase
    .from('tenants')
    .update({
      status: 'active',
      verification_status: 'verified',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error || !provider) return res.status(404).json({ error: 'Provider not found' });

  // adminAuth (middleware/auth.ts) never attaches an identity to req -
  // its x-admin-key path is a shared secret with no per-admin user, and
  // its JWT path doesn't set req.userId either. There is currently no way
  // to record *which* admin took this action, only that one did.
  console.log(`[Admin] Provider approved: ${provider.name} (${provider.slug}). Notes: ${notes || 'none'}`);

  return res.status(200).json({
    success: true,
    message: 'Provider approved and activated',
    provider: {
      id: provider.id,
      slug: provider.slug,
      name: provider.name,
      status: provider.status,
      portalUrl: `https://${provider.slug}.bursary.elimux.ke`,
    },
  });
});

// PATCH /api/admin/bursary-providers/:id/reject
// Protected: super admin
router.patch('/:id/reject', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const { data: provider, error } = await supabase
    .from('tenants')
    .update({
      status: 'cancelled',
      verification_status: 'suspended',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error || !provider) return res.status(404).json({ error: 'Provider not found' });

  console.log(`[Admin] Provider rejected: ${provider.name} (${provider.slug}). Reason: ${reason || 'none'}`);

  return res.status(200).json({
    success: true,
    message: 'Provider rejected',
    provider: { id: provider.id, name: provider.name, status: provider.status },
  });
});

// PATCH /api/admin/bursary-providers/:id/suspend
// Protected: super admin
router.patch('/:id/suspend', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const { data: provider, error } = await supabase
    .from('tenants')
    .update({
      status: 'suspended',
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error || !provider) return res.status(404).json({ error: 'Provider not found' });

  console.log(`[Admin] Provider suspended: ${provider.name} (${provider.slug}). Reason: ${reason || 'none'}`);

  return res.status(200).json({
    success: true,
    message: 'Provider suspended',
    provider: { id: provider.id, name: provider.name, status: provider.status },
  });
});

export default router;
