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

// POST /api/campaigns - Create new campaign (ELIMUX 22: per-click billing mode)
router.post('/', advertiserAuth, async (req: AdvertiserAuthRequest, res: Response): Promise<void> => {
    try {
        const {
            title, description, billing_model = 'cpc', budget, daily_budget, total_budget,
            duration_days, placement, start_date, end_date, image_url, target_url
        } = req.body;

        if (!title || !budget || !duration_days || !placement) {
            res.status(400).json({ error: 'Missing required fields: title, budget, duration_days, placement' });
            return;
        }
        if (!['cpc', 'cpm', 'cpa'].includes(billing_model)) {
            res.status(400).json({ error: 'Invalid billing_model. Use cpc, cpm, or cpa' });
            return;
        }

        // Get pricing settings from key-value platform_settings
        const { data: pricingRows, error: pricingError } = await supabaseAdmin
            .from('platform_settings')
            .select('key, value')
            .in('key', ['ad_min_daily_budget', 'ad_min_campaign_budget', 'ad_max_daily_budget', 'ad_billing_enabled']);
        if (pricingError) throw pricingError;

        const pricing: Record<string, string> = {};
        (pricingRows || []).forEach((row: any) => { pricing[row.key] = row.value; });

        const minDaily = parseFloat(pricing['ad_min_daily_budget'] || '5');
        const minCampaign = parseFloat(pricing['ad_min_campaign_budget'] || '50');
        const maxDaily = parseFloat(pricing['ad_max_daily_budget'] || '10000');
        const billingEnabled = pricing['ad_billing_enabled'] === 'true';

        if (daily_budget && parseFloat(daily_budget) < minDaily) {
            res.status(400).json({ error: `Daily budget must be at least KES ${minDaily}` });
            return;
        }
        if (daily_budget && parseFloat(daily_budget) > maxDaily) {
            res.status(400).json({ error: `Daily budget cannot exceed KES ${maxDaily}` });
            return;
        }
        if (total_budget && parseFloat(total_budget) < minCampaign) {
            res.status(400).json({ error: `Total budget must be at least KES ${minCampaign}` });
            return;
        }

        const { data: advertiser, error: advError } = await supabaseAdmin
            .from('advertisers')
            .select('id, balance, status, total_spent')
            .eq('id', req.advertiserId)
            .single();
        if (advError || !advertiser) {
            res.status(404).json({ error: 'Advertiser not found' });
            return;
        }
        if (advertiser.status !== 'active') {
            res.status(400).json({ error: 'Advertiser account is not active' });
            return;
        }

        // ELIMUX 22: Per-click billing - no upfront deduction
        let status = 'pending_review';
        let balanceDeducted = 0;

        if (!billingEnabled) {
            // Legacy flat-budget mode: deduct upfront
            if (advertiser.balance < parseFloat(budget)) {
                res.status(400).json({ error: 'Insufficient balance for flat-budget campaign' });
                return;
            }
            await supabaseAdmin.from('advertisers').update({ balance: advertiser.balance - parseFloat(budget) }).eq('id', req.advertiserId);
            balanceDeducted = parseFloat(budget);
            status = 'active';
        }

        const { data: campaign, error } = await supabaseAdmin
            .from('ad_campaigns')
            .insert({
                advertiser_id: req.advertiserId,
                title, description: description || '', billing_model,
                budget: parseFloat(budget),
                daily_budget: daily_budget ? parseFloat(daily_budget) : null,
                total_budget: total_budget ? parseFloat(total_budget) : null,
                duration_days: parseInt(duration_days),
                placement,
                start_date: start_date || new Date().toISOString(),
                end_date: end_date || new Date(Date.now() + parseInt(duration_days) * 86400000).toISOString(),
                image_url: image_url || '',
                target_url: target_url || '',
                status,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) {
            if (!billingEnabled && balanceDeducted > 0) {
                await supabaseAdmin.from('advertisers').update({ balance: advertiser.balance }).eq('id', req.advertiserId);
            }
            throw error;
        }

        const { data: campaignWithCost } = await supabaseAdmin
            .from('ad_campaigns')
            .select('cost_per_unit, discount_applied_percent')
            .eq('id', campaign.id)
            .single();

        res.status(201).json({
            success: true,
            message: billingEnabled
                ? 'Campaign created. Pending admin approval. Pay-per-click billing: no upfront charge.'
                : 'Campaign created and activated (flat budget mode).',
            data: {
                ...campaign,
                cost_per_unit: campaignWithCost?.cost_per_unit,
                discount_applied_percent: campaignWithCost?.discount_applied_percent,
                billing_mode: billingEnabled ? 'per_click' : 'flat_budget'
            }
        });
    } catch (error: any) {
        console.error('Create campaign error:', error);
        res.status(500).json({ error: error.message || 'Failed to create campaign' });
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

        // campaign_clicks, not ad_clicks - see 20_campaign_clicks.sql.
        const { data: clicks } = await supabaseAdmin
            .from('campaign_clicks')
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
