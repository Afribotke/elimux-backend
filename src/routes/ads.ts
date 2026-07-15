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
            .eq('campaign_type', mapSlotTypeToCampaignType(slot.slot_type))
            .limit(slot.max_ads);

        if (!campaigns || campaigns.length === 0) {
            res.json({ success: true, data: [] });
            return;
        }

        let eligibleCampaigns = campaigns;

        if (body.country_code && campaigns.some((c: any) => c.target_countries && c.target_countries.length > 0)) {
            eligibleCampaigns = campaigns.filter((c: any) =>
                !c.target_countries ||
                c.target_countries.length === 0 ||
                c.target_countries.includes(body.country_code!)
            );
        }

        const shuffled = eligibleCampaigns.sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, slot.max_ads);

        const servedAds: ServedAd[] = selected.map((campaign: any) => ({
            campaign_id: campaign.id,
            title: campaign.title,
            subtitle: campaign.subtitle,
            image_url: campaign.image_url,
            destination_url: campaign.destination_url,
            cta_text: campaign.cta_text,
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
        const userAgent = req.headers['user-agent'] || '';
        const ipAddress = req.ip || req.socket.remoteAddress || '';
        const deviceType = getDeviceType(userAgent);

        await supabaseAdmin.from('ad_clicks').insert({
            ad_id: ad_id as string,
            user_id: (req as any).userId || null,
            user_device_id: sessionId,
            ip_address: ipAddress,
            user_agent: userAgent,
            country_code: req.query.country as string,
            device_type: deviceType,
            page_url: page as string,
            referrer: req.headers.referer || ''
        });

        const { data: campaign } = await supabaseAdmin
            .from('ad_campaigns')
            .select('billing_model, cpc_rate, cpm_rate, total_spent, total_clicks, budget')
            .eq('id', ad_id as string)
            .single();

        if (campaign && campaign.billing_model === 'cpc') {
            const newSpend = (campaign.total_spent || 0) + (campaign.cpc_rate || 0.50);
            await supabaseAdmin
                .from('ad_campaigns')
                .update({
                    total_spent: newSpend,
                    total_clicks: (campaign.total_clicks || 0) + 1,
                    status: newSpend >= campaign.budget ? 'completed' : 'active'
                })
                .eq('id', ad_id as string);
        }

        if (redirect === 'true') {
            const { data: campaignData } = await supabaseAdmin
                .from('ad_campaigns')
                .select('destination_url')
                .eq('id', ad_id as string)
                .single();

            if (campaignData?.destination_url) {
                res.redirect(campaignData.destination_url);
                return;
            }
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
            .eq('campaign_type', mapSlotTypeToCampaignType(slot.slot_type));

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

function mapSlotTypeToCampaignType(slotType: string): string {
    const mapping: Record<string, string> = {
        'hero': 'homepage_hero',
        'banner': 'banner',
        'featured': 'featured_listing',
        'sponsored': 'sponsored_program',
        'search': 'search_sponsored'
    };
    return mapping[slotType] || 'banner';
}

function generateSessionId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getDeviceType(userAgent: string): string {
    if (/mobile|android|iphone|ipad|ipod/i.test(userAgent)) return 'mobile';
    if (/tablet|ipad/i.test(userAgent)) return 'tablet';
    return 'desktop';
}

export default router;
