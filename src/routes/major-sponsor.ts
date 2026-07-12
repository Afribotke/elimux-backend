import { Router } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /api/major-sponsor — the currently active "Powered by" sponsor (public)
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('major_sponsors')
      .select('organization_name, logo_url, tagline, website_url, sponsorship_tier')
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      console.error('Error fetching major sponsor:', error);
      return res.status(500).json({ error: 'Failed to fetch major sponsor' });
    }

    if (!data) {
      return res.json({ data: null });
    }

    return res.json({
      data: {
        name: data.organization_name,
        logo_url: data.logo_url,
        tagline: data.tagline,
        website_url: data.website_url,
        tier: data.sponsorship_tier,
      },
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
