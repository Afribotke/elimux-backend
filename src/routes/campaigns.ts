// ============================================
// ELIMUX AD PORTAL - CAMPAIGN ROUTES
// ============================================

import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { advertiserAuth, AdvertiserAuthRequest } from '../middleware/advertiser-auth';
import { CreateCampaignRequest, CampaignAnalytics, CampaignPlacement } from '../types/advertiser';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

const VALID_PLACEMENTS: CampaignPlacement[] = ['ribbon', 'homepage_hero', 'search_inline', 'institution_sidebar', 'scholarship_banner'];

// POST /api/campaigns - Create new campaign
router.post('/', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const body: CreateCampaignRequest = req.body;

        // title/image_url/target_url/placement/budget/duration_days are all
        // NOT NULL with no default on ad_campaigns - all six are mandatory.
        if (!body.title || !body.image_url || !body.target_url || !body.placement || !body.budget || !body.duration_days) {
            res.status(400).json({
                error: 'Missing required fields: title, image_url, target_url, placement, budget, duration_days'
            });
            return;
        }

        if (!VALID_PLACEMENTS.includes(body.placement)) {
            res.status(400).json({ error: `Invalid placement. Must be one of: ${VALID_PLACEMENTS.join(', ')}` });
            return;
        }

        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('balance, status')
            .eq('id', req.advertiserId)
            .single();

        if (!advertiser || advertiser.status !== 'active') {
            res.status(403).json({ error: 'Advertiser not approved' });
            return;
        }

        if (body.budget > advertiser.balance) {
            res.status(400).json({
                error: 'Insufficient balance',
                balance: advertiser.balance,
                required: body.budget
            });
            return;
        }

        const insertData: any = {
            advertiser_id: req.advertiserId,
            title: body.title,
            description: body.description,
            headline: body.headline,
            image_url: body.image_url,
            image_dimensions: body.image_dimensions,
            target_url: body.target_url,
            placement: body.placement,
            budget: body.budget,
            duration_days: body.duration_days,
            auto_renew: body.auto_renew || false,
            status: 'draft',
            impressions: 0,
            clicks: 0
        };

        if (body.start_date && body.end_date) {
            insertData.start_date = body.start_date;
            insertData.end_date = body.end_date;
        }

        const { data: campaign, error } = await supabaseAdmin
            .from('ad_campaigns')
            .insert(insertData)
            .select()
            .single();

        if (error) {
            console.error('Create campaign error:', error);
            res.status(500).json({ error: 'Failed to create campaign', details: error.message });
            return;
        }

        res.status(201).json({
            success: true,
            message: 'Campaign created successfully',
            data: campaign
        });
    } catch (error: any) {
        console.error('Create campaign error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/campaigns - List advertiser's campaigns
router.get('/', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { status, page = '1', limit = '10' } = req.query;
        const pageNum = parseInt(page as string, 10);
        const limitNum = parseInt(limit as string, 10);
        const offset = (pageNum - 1) * limitNum;

        let query = supabaseAdmin
            .from('ad_campaigns')
            .select('*', { count: 'exact' })
            .eq('advertiser_id', req.advertiserId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limitNum - 1);

        if (status) {
            query = query.eq('status', status);
        }

        const { data: campaigns, error, count } = await query;

        if (error) {
            res.status(500).json({ error: 'Failed to fetch campaigns', details: error.message });
            return;
        }

        res.json({
            success: true,
            data: campaigns,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limitNum)
            }
        });
    } catch (error: any) {
        console.error('List campaigns error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/campaigns/:id - Get campaign details
router.get('/:id', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        const { data: campaign, error } = await supabaseAdmin
            .from('ad_campaigns')
            .select('*')
            .eq('id', id)
            .single();

        if (error || !campaign) {
            res.status(404).json({ error: 'Campaign not found' });
            return;
        }

        if (!req.isAdmin && campaign.advertiser_id !== req.advertiserId) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        res.json({ success: true, data: campaign });
    } catch (error: any) {
        console.error('Get campaign error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/campaigns/:id - Update campaign
router.put('/:id', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const body = req.body;

        const { data: existing } = await supabaseAdmin
            .from('ad_campaigns')
            .select('*')
            .eq('id', id)
            .single();

        if (!existing) {
            res.status(404).json({ error: 'Campaign not found' });
            return;
        }

        if (!req.isAdmin && existing.advertiser_id !== req.advertiserId) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        if (existing.status === 'active' || existing.status === 'completed') {
            res.status(400).json({ error: 'Cannot edit active or completed campaigns' });
            return;
        }

        const { data: campaign, error } = await supabaseAdmin
            .from('ad_campaigns')
            .update({
                ...body,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to update campaign', details: error.message });
            return;
        }

        res.json({ success: true, data: campaign });
    } catch (error: any) {
        console.error('Update campaign error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/campaigns/:id - Delete campaign
router.delete('/:id', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        const { data: existing } = await supabaseAdmin
            .from('ad_campaigns')
            .select('advertiser_id, status')
            .eq('id', id)
            .single();

        if (!existing) {
            res.status(404).json({ error: 'Campaign not found' });
            return;
        }

        if (!req.isAdmin && existing.advertiser_id !== req.advertiserId) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        if (existing.status === 'active') {
            res.status(400).json({ error: 'Cannot delete active campaigns. Pause first.' });
            return;
        }

        const { error } = await supabaseAdmin
            .from('ad_campaigns')
            .delete()
            .eq('id', id);

        if (error) {
            res.status(500).json({ error: 'Failed to delete campaign', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Campaign deleted' });
    } catch (error: any) {
        console.error('Delete campaign error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/campaigns/:id/submit - Submit campaign for review
router.post('/:id/submit', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        const { data: existing } = await supabaseAdmin
            .from('ad_campaigns')
            .select('advertiser_id, status')
            .eq('id', id)
            .single();

        if (!existing) {
            res.status(404).json({ error: 'Campaign not found' });
            return;
        }

        if (!req.isAdmin && existing.advertiser_id !== req.advertiserId) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        if (existing.status !== 'draft') {
            res.status(400).json({ error: 'Only draft campaigns can be submitted' });
            return;
        }

        const { data: campaign, error } = await supabaseAdmin
            .from('ad_campaigns')
            .update({ status: 'pending_review' })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to submit campaign', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Campaign submitted for review', data: campaign });
    } catch (error: any) {
        console.error('Submit campaign error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/campaigns/:id/pause - Pause campaign
router.post('/:id/pause', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        const { data: existing } = await supabaseAdmin
            .from('ad_campaigns')
            .select('advertiser_id, status')
            .eq('id', id)
            .single();

        if (!existing) {
            res.status(404).json({ error: 'Campaign not found' });
            return;
        }

        if (!req.isAdmin && existing.advertiser_id !== req.advertiserId) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        if (existing.status !== 'active') {
            res.status(400).json({ error: 'Only active campaigns can be paused' });
            return;
        }

        const { data: campaign, error } = await supabaseAdmin
            .from('ad_campaigns')
            .update({ status: 'paused' })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to pause campaign', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Campaign paused', data: campaign });
    } catch (error: any) {
        console.error('Pause campaign error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/campaigns/:id/analytics - Get campaign analytics
router.get('/:id/analytics', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;
        const { days = '30' } = req.query;

        const { data: campaign } = await supabaseAdmin
            .from('ad_campaigns')
            .select('*')
            .eq('id', id)
            .single();

        if (!campaign) {
            res.status(404).json({ error: 'Campaign not found' });
            return;
        }

        if (!req.isAdmin && campaign.advertiser_id !== req.advertiserId) {
            res.status(403).json({ error: 'Access denied' });
            return;
        }

        const daysNum = parseInt(days as string, 10);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysNum);

        const { data: impressions } = await supabaseAdmin
            .from('ad_impressions')
            .select('created_at')
            .eq('ad_id', id)
            .gte('created_at', startDate.toISOString());

        const { data: clicks } = await supabaseAdmin
            .from('ad_clicks')
            .select('clicked_at')
            .eq('ad_id', id)
            .gte('clicked_at', startDate.toISOString());

        const dailyStats: Record<string, any> = {};
        for (let i = 0; i < daysNum; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            dailyStats[dateStr] = { date: dateStr, impressions: 0, clicks: 0 };
        }

        impressions?.forEach((imp: any) => {
            const dateStr = imp.created_at.split('T')[0];
            if (dailyStats[dateStr]) dailyStats[dateStr].impressions++;
        });

        clicks?.forEach((click: any) => {
            const dateStr = click.clicked_at.split('T')[0];
            if (dailyStats[dateStr]) dailyStats[dateStr].clicks++;
        });

        const analytics: CampaignAnalytics = {
            campaign_id: id as string,
            impressions: campaign.impressions || 0,
            clicks: campaign.clicks || 0,
            ctr: (campaign.impressions || 0) > 0
                ? ((campaign.clicks || 0) / campaign.impressions) * 100
                : 0,
            daily_stats: Object.values(dailyStats).reverse() as any
        };

        res.json({ success: true, data: analytics });
    } catch (error: any) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
