// ============================================
// ELIMUX AD PORTAL - TYPE DEFINITIONS
// Matches actual Supabase schema (verified against information_schema,
// not the original design doc - the tables as built are simpler than
// what earlier drafts of this feature assumed, see elimux-sql/18_*.sql)
// ============================================

export interface Advertiser {
    id: string;
    user_id: string;
    organization_name: string;
    organization_type: string;
    email: string;
    phone?: string;
    password_hash?: string;
    logo_url?: string;
    website_url?: string;
    business_registration_number?: string;
    business_certificate_url?: string;
    is_email_verified: boolean;
    is_business_verified: boolean;
    is_trusted: boolean;
    // Verified exhaustively against the actual CHECK constraint - no
    // 'approved'/'rejected' values exist, only these three.
    status: 'pending' | 'active' | 'suspended';
    balance: number;
    total_spent: number;
    created_at: string;
    updated_at: string;
}

export interface AdCampaign {
    id: string;
    advertiser_id: string;
    title: string;
    description?: string;
    headline?: string;
    image_url?: string;
    image_dimensions?: string;
    target_url: string;
    placement: CampaignPlacement;
    is_powered_by: boolean;
    status: 'draft' | 'pending_review' | 'approved' | 'active' | 'paused' | 'completed' | 'rejected';
    budget: number;
    duration_days?: number;
    start_date?: string;
    end_date?: string;
    auto_renew: boolean;
    impressions: number;
    clicks: number;
    rejection_reason?: string;
    created_at: string;
    updated_at: string;
}

export interface AdSlot {
    id: string;
    name: string;
    slot_type: string;
    position: string;
    page: string;
    dimensions?: string;
    max_ads: number;
    is_active: boolean;
    base_cpc_rate: number;
    base_cpm_rate: number;
    description?: string;
}

export interface AdImpression {
    id: string;
    ad_id: string;
    user_id?: string;
    user_device_id?: string;
    ip_address?: string;
    user_agent?: string;
    country_code?: string;
    device_type?: string;
    page_url?: string;
    slot_id?: string;
    created_at: string;
}

export interface AdClick {
    id: string;
    ad_id: string;
    user_device_id?: string;
    ip_address?: string;
    clicked_at: string;
}

export interface AdPayment {
    id: string;
    campaign_id: string;
    amount: number;
    paystack_reference?: string;
    paystack_status?: string;
    status: 'pending' | 'completed' | 'failed' | 'refunded';
    paid_at?: string;
    created_at: string;
}

// Verified exhaustively against the actual CHECK constraint
// (ad_campaigns_placement_check) - unrelated to ad_slots.slot_type/name,
// which use a different vocabulary entirely ('banner', 'hero', 'search', ...
// vs these). Only 'homepage_hero' happens to overlap between the two.
export type CampaignPlacement = 'ribbon' | 'homepage_hero' | 'search_inline' | 'institution_sidebar' | 'scholarship_banner';

export interface CreateCampaignRequest {
    title: string;
    description?: string;
    headline?: string;
    image_url: string;
    image_dimensions?: string;
    target_url: string;
    placement: CampaignPlacement;
    budget: number;
    duration_days: number;
    start_date?: string;
    end_date?: string;
    auto_renew?: boolean;
}

export interface CampaignAnalytics {
    campaign_id: string;
    impressions: number;
    clicks: number;
    ctr: number;
    daily_stats: {
        date: string;
        impressions: number;
        clicks: number;
    }[];
}

export interface ServeAdRequest {
    slot_name: string;
    page_url: string;
    country_code?: string;
    device_type?: string;
}

export interface ServedAd {
    campaign_id: string;
    title: string;
    headline?: string;
    image_url?: string;
    target_url: string;
    slot_name: string;
    tracking_url: string;
}

export interface CreatePaymentRequest {
    amount: number;
    campaign_id: string;
}
