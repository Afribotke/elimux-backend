// ============================================
// ELIMUX AD PORTAL - ADVERTISER ROUTES
// ============================================

import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { advertiserAuth, AdvertiserAuthRequest } from '../middleware/advertiser-auth';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// POST /api/advertiser/register - Register as an advertiser
router.post('/register', async (req: Request, res: Response): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        const {
            company_name,
            company_email,
            company_phone,
            company_website,
            industry_type,
            tax_id,
            billing_address
        } = req.body;

        if (!company_name || !company_email || !industry_type) {
            res.status(400).json({ error: 'company_name, company_email, and industry_type are required' });
            return;
        }

        const { data: existing } = await supabaseAdmin
            .from('advertisers')
            .select('id')
            .eq('user_id', user.id)
            .single();

        if (existing) {
            res.status(409).json({ error: 'Already registered as an advertiser' });
            return;
        }

        const { data: advertiser, error: insertError } = await supabaseAdmin
            .from('advertisers')
            .insert({
                user_id: user.id,
                company_name,
                company_email,
                company_phone,
                company_website,
                organization_type: industry_type,
                tax_id,
                billing_address,
                status: 'pending',
                balance: 0,
                total_spent: 0,
                password_hash: null
            })
            .select()
            .single();

        if (insertError) {
            console.error('Insert error:', insertError);
            res.status(500).json({ error: 'Failed to create advertiser', details: insertError.message });
            return;
        }

        res.status(201).json({
            success: true,
            message: 'Advertiser profile created. Pending approval.',
            data: advertiser
        });
    } catch (error: any) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/advertiser/profile - Get own advertiser profile
router.get('/profile', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { data: advertiser, error } = await supabaseAdmin
            .from('advertisers')
            .select('*')
            .eq('user_id', req.userId)
            .single();

        if (error || !advertiser) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }

        res.json({ success: true, data: advertiser });
    } catch (error: any) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/advertiser/profile - Update advertiser profile
router.put('/profile', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const {
            company_name,
            company_email,
            company_phone,
            company_website,
            tax_id,
            billing_address
        } = req.body;

        const { data: advertiser, error } = await supabaseAdmin
            .from('advertisers')
            .update({
                company_name,
                company_email,
                company_phone,
                company_website,
                tax_id,
                billing_address,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', req.userId)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to update profile', details: error.message });
            return;
        }

        res.json({ success: true, data: advertiser });
    } catch (error: any) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/advertiser/stats - Get advertiser dashboard stats
router.get('/stats', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('id, balance, total_spent')
            .eq('user_id', req.userId)
            .single();

        if (!advertiser) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }

        const { data: campaigns } = await supabaseAdmin
            .from('ad_campaigns')
            .select('status, total_impressions, total_clicks, total_spent')
            .eq('advertiser_id', advertiser.id);

        const stats = {
            balance: advertiser.balance,
            total_spent: advertiser.total_spent,
            total_campaigns: campaigns?.length || 0,
            active_campaigns: campaigns?.filter((c: any) => c.status === 'active').length || 0,
            total_impressions: campaigns?.reduce((sum: number, c: any) => sum + (c.total_impressions || 0), 0) || 0,
            total_clicks: campaigns?.reduce((sum: number, c: any) => sum + (c.total_clicks || 0), 0) || 0,
            total_ctr: campaigns && campaigns.length > 0
                ? ((campaigns.reduce((sum: number, c: any) => sum + (c.total_clicks || 0), 0) /
                    Math.max(campaigns.reduce((sum: number, c: any) => sum + (c.total_impressions || 0), 0), 1)) * 100).toFixed(2)
                : '0.00'
        };

        res.json({ success: true, data: stats });
    } catch (error: any) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/advertiser/all - Admin only: List all advertisers
router.get('/all', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        if (!req.isAdmin) {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }

        const { data: advertisers, error } = await supabaseAdmin
            .from('advertisers')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) {
            res.status(500).json({ error: 'Failed to fetch advertisers', details: error.message });
            return;
        }

        res.json({ success: true, data: advertisers });
    } catch (error: any) {
        console.error('All advertisers error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/advertiser/:id/approve - Admin only: Approve advertiser
router.put('/:id/approve', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        if (!req.isAdmin) {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }

        const { id } = req.params;

        const { data: advertiser, error } = await supabaseAdmin
            .from('advertisers')
            .update({
                status: 'approved',
                approved_at: new Date().toISOString(),
                approved_by: req.userId
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to approve advertiser', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Advertiser approved', data: advertiser });
    } catch (error: any) {
        console.error('Approve error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/advertiser/:id/reject - Admin only: Reject advertiser
router.put('/:id/reject', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        if (!req.isAdmin) {
            res.status(403).json({ error: 'Admin access required' });
            return;
        }

        const { id } = req.params;
        const { review_notes } = req.body;

        const { data: advertiser, error } = await supabaseAdmin
            .from('advertisers')
            .update({
                status: 'rejected',
                review_notes
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to reject advertiser', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Advertiser rejected', data: advertiser });
    } catch (error: any) {
        console.error('Reject error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
