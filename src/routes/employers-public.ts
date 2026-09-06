import { Router } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /api/employers-public — public: search employers by name/domain (for /join).
// Deliberately NOT mounted at /api/employers - that path already serves a
// different, student-auth-gated listing (GET /employers in internships.ts,
// mounted via app.use('/api', internshipsRouter)). Mounting here too would
// have silently shadowed or been shadowed by that route (and by its
// /employers/:slug catch-all) depending on registration order.
router.get('/', async (req, res) => {
  try {
    const { search, domain } = req.query;
    let query = supabase
      .from('employers')
      .select('id, company_name, location_county, industry, website_url')
      .eq('is_active', true);

    if (search && typeof search === 'string') {
      query = query.ilike('company_name', `%${search}%`);
    }

    if (domain && typeof domain === 'string') {
      query = query.ilike('website_url', `%${domain}%`);
    }

    const { data, error } = await query.limit(10);

    if (error) throw error;
    res.json({ data, count: data?.length || 0 });
  } catch (err) {
    console.error('Employer search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
