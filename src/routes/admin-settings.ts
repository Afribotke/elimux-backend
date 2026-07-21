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

export default router;
