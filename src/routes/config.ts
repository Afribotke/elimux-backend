import { Router } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// Whitelisted public display settings — never expose the whole table
const PUBLIC_KEYS = [
  'ad_placeholder_price_kes',
  'ad_placeholder_price_usd',
  'show_public_impressions',
  'ad_tier_basic_kes',
  'ad_tier_basic_usd',
  'ad_tier_standard_kes',
  'ad_tier_standard_usd',
  'ad_tier_premium_kes',
  'ad_tier_premium_usd',
] as const;

// GET /api/config/public - public display config (prices, display flags)
router.get('/public', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('key, value')
      .in('key', [...PUBLIC_KEYS]);

    if (error) {
      console.error('Error fetching public config:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const config: Record<string, string> = {};
    for (const row of data || []) config[row.key] = row.value;
    return res.json({ data: config });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
