// ============================================
// ELIMUX AD PORTAL - CAMPAIGN ROUTES
// ============================================

import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { advertiserAuth, AdvertiserAuthRequest } from '../middleware/advertiser-auth';
import { CreateCampaignRequest, CampaignAnalytics } from '../types/advertiser';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// POST /api/campaigns - Create new campaign
router.post('/', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const body: CreateCampaignRequest = req.body;

        if (!body.name || !body.campaign_type || !body.title || !body.destination_url || !body.budget) {
            res.status(400).json({
                error: 'Missing required fields: name, campaign_type, title, destination_url, budget'
            });
            return;
        }

        const { data: advertiser } = await supabaseAdmin
            .from('advertisers')
            .select('balance, status')
            .eq('id', req.advertiserId)
            .single();

        if (!advertiser || advertiser.status !== 'approved') {
            res.status(403).json({ error: 'Advertiser not approved' });
            return;
        }

        if (body.billing_model !== 'flat_fee' && body.budget > advertiser.balance) {
            res.status(400).json({
                error: 'Insufficient balance',
                balance: advertiser.balance,
                required: body.budget
            });
            return;
        }

        const insertData: any = {
            advertiser_id: req.advertiserId,
            name: body.name,
            description: body.description,
            campaign_type: body.campaign_type,
            target_countries: body.target_countries || [],
            target_institution_types: body.target_institution_types || [],
            target_categories: body.target_categories || [],
            target_audience: body.target_audience || 'all',
            title: body.title,
            subtitle: body.subtitle,
            image_url: body.image_url,
            destination_url: body.destination_url,
            cta_text: body.cta_text || 'Learn More',
            budget: body.budget,
            daily_budget: body.daily_budget,
            billing_model: body.billing_model || 'cpc',
            cpc_rate: body.cpc_rate || 0.50,
            cpm_rate: body.cpm_rate || 5.00,
            status: 'draft',
            total_impressions: 0,
            total_clicks: 0,
            total_conversions: 0,
            total_spent: 0
        };

        if (body.start_date && body.end_date) {
            insertData.start_date = body.start_date;
            insertData.end_date = body.end_date;
        }
        if (body.duration_days) {
            insertData.duration_days = body.duration_days;
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
            .select('created_at')
            .eq('ad_id', id)
            .gte('created_at', startDate.toISOString());

        const dailyStats: Record<string, any> = {};
        for (let i = 0; i < daysNum; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            dailyStats[dateStr] = { date: dateStr, impressions: 0, clicks: 0, conversions: 0, spend: 0 };
        }

        impressions?.forEach((imp: any) => {
            const dateStr = imp.created_at.split('T')[0];
            if (dailyStats[dateStr]) dailyStats[dateStr].impressions++;
        });

        clicks?.forEach((click: any) => {
            const dateStr = click.created_at.split('T')[0];
            if (dailyStats[dateStr]) dailyStats[dateStr].clicks++;
        });

        const analytics: CampaignAnalytics = {
            campaign_id: id as string,
            total_impressions: campaign.total_impressions || 0,
            total_clicks: campaign.total_clicks || 0,
            total_conversions: campaign.total_conversions || 0,
            total_spent: campaign.total_spent || 0,
            ctr: (campaign.total_impressions || 0) > 0
                ? ((campaign.total_clicks || 0) / campaign.total_impressions) * 100
                : 0,
            cpc: (campaign.total_clicks || 0) > 0
                ? (campaign.total_spent || 0) / campaign.total_clicks
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
