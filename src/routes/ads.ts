// ============================================
// ELIMUX AD PORTAL - AD SERVING & TRACKING
// ============================================

import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { ServeAdRequest, ServedAd } from '../types/advertiser';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// POST /api/ads/serve - Serve ads (PUBLIC, NO AUTH)
router.post('/serve', async (req: Request, res: Response): Promise<void> => {
    try {
        const body: ServeAdRequest = req.body;

        if (!body.slot_name || !body.page_url) {
            res.status(400).json({ error: 'slot_name and page_url are required' });
            return;
        }

        const { data: slot } = await supabaseAdmin
            .from('ad_slots')
            .select('*')
            .eq('name', body.slot_name)
            .eq('is_active', true)
            .single();

        if (!slot) {
            res.status(404).json({ error: 'Ad slot not found or inactive' });
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        const { data: campaigns } = await supabaseAdmin
            .from('ad_campaigns')
            .select('*')
            .eq('status', 'active')
            .lte('start_date', today)
            .gte('end_date', today)
            .eq('placement', slot.slot_type)
            .limit(slot.max_ads);

        if (!campaigns || campaigns.length === 0) {
            res.json({ success: true, data: [] });
            return;
        }

        // No per-campaign targeting columns in the actual schema (country/
        // institution-type/category/audience) - every active campaign for
        // this placement is eligible, randomized for fair rotation.
        const shuffled = [...campaigns].sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, slot.max_ads);

        const servedAds: ServedAd[] = selected.map((campaign: any) => ({
            campaign_id: campaign.id,
            title: campaign.title,
            headline: campaign.headline,
            image_url: campaign.image_url,
            target_url: campaign.target_url,
            slot_name: body.slot_name,
            tracking_url: `${process.env.NEXT_PUBLIC_API_URL || ''}/api/ads/click?ad_id=${campaign.id}&slot=${body.slot_name}&page=${encodeURIComponent(body.page_url)}`
        }));

        const sessionId = req.headers['x-session-id'] as string || generateSessionId();
        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.socket.remoteAddress || '';
        const deviceType = getDeviceType(userAgent);

        selected.forEach(async (campaign: any) => {
            try {
                await supabaseAdmin.from('ad_impressions').insert({
                    ad_id: campaign.id,
                    user_id: (req as any).userId || null,
                    user_device_id: sessionId,
                    ip_address: ipAddress,
                    user_agent: userAgent,
                    country_code: body.country_code,
                    device_type: deviceType,
                    page_url: body.page_url,
                    slot_id: slot.id
                });
            } catch (e) {
                console.error('Failed to record impression:', e);
            }
        });

        res.json({
            success: true,
            data: servedAds,
            session_id: sessionId
        });
    } catch (error: any) {
        console.error('Serve ads error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/ads/click - Track ad click (PUBLIC)
router.get('/click', async (req: Request, res: Response): Promise<void> => {
    try {
        const { ad_id, slot, page, redirect } = req.query;

        if (!ad_id) {
            res.status(400).json({ error: 'ad_id is required' });
            return;
        }

        const sessionId = req.headers['x-session-id'] as string || generateSessionId();
        const ipAddress = req.ip || req.socket.remoteAddress || '';

        // ELIMUX 22: Atomically deduct per-click cost
        const { data: costData, error: costError } = await supabaseAdmin.rpc('deduct_click_cost', {
            p_campaign_id: ad_id as string,
            p_click_type: 'click'
        });
        const costDeducted = costData || 0;
        if (costError) console.error('Click billing error:', costError);

        // campaign_clicks, not ad_clicks - ad_clicks.ad_id FKs to
        // sponsor_ads(id) and is owned by the separate sponsor-ads feature.
        // See 20_campaign_clicks.sql.
        await supabaseAdmin.from('campaign_clicks').insert({
            ad_id: ad_id as string,
            campaign_id: ad_id as string,
            user_device_id: sessionId,
            ip_address: ipAddress,
            cost_deducted: costDeducted,
            click_type: 'click'
        });

        // No billing_model/cpc_rate columns in the actual schema - campaigns
        // run for their date range/budget window, not per-click spend, so
        // this just counts the click.
        const { data: campaign } = await supabaseAdmin
            .from('ad_campaigns')
            .select('clicks, target_url')
            .eq('id', ad_id as string)
            .single();

        if (campaign) {
            await supabaseAdmin
                .from('ad_campaigns')
                .update({ clicks: (campaign.clicks || 0) + 1 })
                .eq('id', ad_id as string);
        }

        if (redirect === 'true' && campaign?.target_url) {
            res.redirect(campaign.target_url);
            return;
        }

        res.json({ success: true, message: 'Click tracked' });
    } catch (error: any) {
        console.error('Click tracking error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/ads/slots - List all ad slots (PUBLIC)
router.get('/slots', async (req: Request, res: Response): Promise<void> => {
    try {
        const { data: slots, error } = await supabaseAdmin
            .from('ad_slots')
            .select('*')
            .eq('is_active', true)
            .order('name');

        if (error) {
            res.status(500).json({ error: 'Failed to fetch slots', details: error.message });
            return;
        }

        res.json({ success: true, data: slots });
    } catch (error: any) {
        console.error('Slots error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/ads/slots/:name - Get slot details
router.get('/slots/:name', async (req: Request, res: Response): Promise<void> => {
    try {
        const { name } = req.params;

        const { data: slot, error } = await supabaseAdmin
            .from('ad_slots')
            .select('*')
            .eq('name', name)
            .single();

        if (error || !slot) {
            res.status(404).json({ error: 'Slot not found' });
            return;
        }

        const today = new Date().toISOString().split('T')[0];
        const { count } = await supabaseAdmin
            .from('ad_campaigns')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'active')
            .lte('start_date', today)
            .gte('end_date', today)
            .eq('placement', slot.slot_type);

        res.json({
            success: true,
            data: {
                ...slot,
                active_campaigns: count || 0,
                availability: Math.max(0, slot.max_ads - (count || 0))
            }
        });
    } catch (error: any) {
        console.error('Slot detail error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/ads/homepage - Active campaigns for the homepage ads section (PUBLIC)
router.get('/homepage', async (_req: Request, res: Response) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('ad_campaigns')
            .select('id, headline, description, chips, cta_label, target_url, vertical, featured, advertisers(organization_name, logo_url)')
            .eq('status', 'active')
            .order('featured', { ascending: false });

        if (error) {
            console.error('Error fetching homepage ads:', error);
            return res.status(500).json({ error: 'Internal server error' });
        }

        const ads = (data || []).map((row: any) => ({
            id: row.id,
            name: row.advertisers?.organization_name || row.headline,
            logo_url: row.advertisers?.logo_url || null,
            title: row.headline,
            description: row.description,
            chips: Array.isArray(row.chips) ? row.chips : [],
            cta_label: row.cta_label || 'Learn more',
            cta_url: `/api/ads/click?ad_id=${row.id}&redirect=true`,
            vertical: row.vertical,
            featured: row.featured === true,
        }));

        return res.json({ data: ads });
    } catch (error) {
        console.error('Unexpected error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ELIMUX 22: POST /api/ads/impression - CPM impression tracking (PUBLIC)
router.post('/impression', async (req: Request, res: Response): Promise<void> => {
    try {
        const { ad_id } = req.query;
        if (!ad_id) {
            res.status(400).json({ error: 'Missing ad_id' });
            return;
        }
        const campaignId = ad_id as string;
        const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
        const userDeviceId = req.query.user_device_id as string || `anon_${ipAddress}`;

        const { data: costData } = await supabaseAdmin.rpc('deduct_click_cost', {
            p_campaign_id: campaignId, p_click_type: 'impression'
        });
        const costDeducted = costData || 0;

        await supabaseAdmin.from('campaign_clicks').insert({
            ad_id: campaignId, campaign_id: campaignId,
            user_device_id: userDeviceId, ip_address: ipAddress,
            cost_deducted: costDeducted, click_type: 'impression'
        });

        res.json({ success: true, billed: costDeducted > 0, cost: costDeducted });
    } catch (error: any) {
        console.error('Track impression error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ELIMUX 22: POST /api/ads/conversion - CPA conversion tracking (PUBLIC)
router.post('/conversion', async (req: Request, res: Response): Promise<void> => {
    try {
        const { ad_id } = req.query;
        if (!ad_id) {
            res.status(400).json({ error: 'Missing ad_id' });
            return;
        }
        const campaignId = ad_id as string;
        const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
        const userDeviceId = req.query.user_device_id as string || `anon_${ipAddress}`;

        const { data: costData } = await supabaseAdmin.rpc('deduct_click_cost', {
            p_campaign_id: campaignId, p_click_type: 'conversion'
        });
        const costDeducted = costData || 0;

        await supabaseAdmin.from('campaign_clicks').insert({
            ad_id: campaignId, campaign_id: campaignId,
            user_device_id: userDeviceId, ip_address: ipAddress,
            cost_deducted: costDeducted, click_type: 'conversion'
        });

        res.json({ success: true, billed: costDeducted > 0, cost: costDeducted });
    } catch (error: any) {
        console.error('Track conversion error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ELIMUX 22: GET /api/ads/stats - Campaign click stats with cost data
router.get('/stats', async (req: Request, res: Response): Promise<void> => {
    try {
        const { campaign_id } = req.query;
        if (!campaign_id) {
            res.status(400).json({ error: 'Missing campaign_id' });
            return;
        }

        const { data: clicks } = await supabaseAdmin
            .from('campaign_clicks')
            .select('click_type, cost_deducted')
            .eq('campaign_id', campaign_id);

        const stats = { total_clicks: 0, total_impressions: 0, total_conversions: 0, total_cost: 0 };
        (clicks || []).forEach((row: any) => {
            if (row.click_type === 'click') stats.total_clicks++;
            if (row.click_type === 'impression') stats.total_impressions++;
            if (row.click_type === 'conversion') stats.total_conversions++;
            stats.total_cost += parseFloat(row.cost_deducted || 0);
        });

        const { data: campaign } = await supabaseAdmin
            .from('ad_campaigns')
            .select('total_spend, platform_fee, partner_commission, actual_clicks, actual_impressions, actual_conversions')
            .eq('id', campaign_id)
            .single();

        res.json({ success: true, data: { ...stats, campaign_totals: campaign || null } });
    } catch (error: any) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function generateSessionId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getDeviceType(userAgent: string): string {
    if (/mobile|android|iphone|ipad|ipod/i.test(userAgent)) return 'mobile';
    if (/tablet|ipad/i.test(userAgent)) return 'tablet';
    return 'desktop';
}

export default router;
