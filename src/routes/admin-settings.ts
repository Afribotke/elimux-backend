// ============================================
// ELIMUX ADMIN - PLATFORM SETTINGS API
// Founder pricing portal backend.
// GET   /api/admin/settings       -> list all settings
// PATCH /api/admin/settings/:key  -> update one setting
// Same X-Admin-Key protection as /api/admin/campaigns.
// ============================================

import { Router, Request, Response } from 'express';
import { adminMiddleware } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = Router();

// Price keys must be non-negative numbers
const NUMERIC_KEY = /(_kes|_usd)$/;
const BOOLEAN_KEYS = new Set(['show_public_impressions']);

// ELIMUX 22: Ad pricing keys (subset of platform_settings)
const AD_PRICING_KEYS = [
    'ad_cpc_rate', 'ad_cpm_rate', 'ad_cpa_rate',
    'ad_min_daily_budget', 'ad_min_campaign_budget', 'ad_max_daily_budget',
    'ad_platform_fee_percent', 'ad_partner_commission_percent',
    'ad_tier_1_threshold', 'ad_tier_1_discount',
    'ad_tier_2_threshold', 'ad_tier_2_discount',
    'ad_tier_3_threshold', 'ad_tier_3_discount',
    'ad_billing_enabled'
];

router.get('/', adminMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
        const { data, error } = await supabase
            .from('platform_settings')
            .select('key, value, description')
            .order('key', { ascending: true });
        if (error) {
            res.status(500).json({ error: 'Failed to load settings', details: error.message });
            return;
        }
        res.json({ success: true, data: data || [] });
    } catch {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.patch('/:key', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
        const key = String(req.params.key);
        const value = req.body?.value;

        if (typeof value !== 'string' || value.trim() === '') {
            res.status(400).json({ error: 'Body must include a non-empty string "value".' });
            return;
        }

        // Only keys that already exist can be updated — stops typos
        // from creating junk rows in the central pricing table.
        const { data: existing } = await supabase
            .from('platform_settings')
            .select('key')
            .eq('key', key)
            .single();

        if (!existing) {
            res.status(404).json({ error: `Unknown setting key: ${key}` });
            return;
        }

        if (NUMERIC_KEY.test(key)) {
            const n = Number(value);
            if (Number.isNaN(n) || n < 0) {
                res.status(400).json({ error: `Setting ${key} must be a non-negative number.` });
                return;
            }
        }

        if (BOOLEAN_KEYS.has(key) && value !== 'true' && value !== 'false') {
            res.status(400).json({ error: `Setting ${key} must be "true" or "false".` });
            return;
        }

        const { data, error } = await supabase
            .from('platform_settings')
            .update({ value: value.trim() })
            .eq('key', key)
            .select('key, value, description')
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to update setting', details: error.message });
            return;
        }

        res.json({ success: true, message: `Updated ${key}`, data });
    } catch {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ELIMUX 22: GET /api/admin/settings/ad-pricing - ad pricing settings only
router.get('/ad-pricing', adminMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
        const { data, error } = await supabase
            .from('platform_settings')
            .select('key, value, description')
            .in('key', AD_PRICING_KEYS);
        if (error) throw error;

        const settings: Record<string, any> = {};
        (data || []).forEach((row: any) => {
            settings[row.key] = row.key === 'ad_billing_enabled' ? row.value === 'true' : parseFloat(row.value) || 0;
        });

        const defaults: Record<string, any> = {
            ad_cpc_rate: 0.50, ad_cpm_rate: 5.00, ad_cpa_rate: 10.00,
            ad_min_daily_budget: 5.00, ad_min_campaign_budget: 50.00, ad_max_daily_budget: 10000.00,
            ad_platform_fee_percent: 15.00, ad_partner_commission_percent: 10.00,
            ad_tier_1_threshold: 500.00, ad_tier_1_discount: 5.00,
            ad_tier_2_threshold: 2000.00, ad_tier_2_discount: 10.00,
            ad_tier_3_threshold: 5000.00, ad_tier_3_discount: 15.00,
            ad_billing_enabled: true
        };
        AD_PRICING_KEYS.forEach((key) => { if (settings[key] === undefined) settings[key] = defaults[key]; });

        res.json({ success: true, data: settings });
    } catch (err: any) {
        console.error('Get ad pricing error:', err);
        res.status(500).json({ error: err.message || 'Failed to fetch ad pricing' });
    }
});

// ELIMUX 22: PUT /api/admin/settings/ad-pricing - update ad pricing settings
router.put('/ad-pricing', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
        const updates = req.body;
        const results: any[] = [];
        const errors: string[] = [];

        for (const [key, value] of Object.entries(updates)) {
            if (!AD_PRICING_KEYS.includes(key)) { errors.push(`"${key}" is not a valid ad pricing key`); continue; }

            let stringValue: string;
            if (key === 'ad_billing_enabled') {
                stringValue = (value === true || value === 'true') ? 'true' : 'false';
            } else {
                const numValue = parseFloat(value as string);
                if (isNaN(numValue)) { errors.push(`Invalid numeric value for ${key}: ${value}`); continue; }
                if (numValue < 0) { errors.push(`${key} cannot be negative`); continue; }
                if (key.includes('_percent') && numValue > 100) { errors.push(`${key} cannot exceed 100%`); continue; }
                stringValue = String(numValue);
            }

            const { data, error } = await supabase
                .from('platform_settings')
                .upsert({ key, value: stringValue }, { onConflict: 'key' })
                .select()
                .single();

            if (error) errors.push(`Failed to update ${key}: ${error.message}`);
            else results.push(data);
        }

        if (errors.length > 0 && results.length === 0) {
            res.status(400).json({ success: false, error: 'All updates failed', details: errors });
            return;
        }

        res.json({ success: true, message: `Updated ${results.length} ad pricing setting(s)`, data: results, errors: errors.length > 0 ? errors : undefined });
    } catch (err: any) {
        console.error('Update ad pricing error:', err);
        res.status(500).json({ error: err.message || 'Failed to update ad pricing' });
    }
});

export default router;
