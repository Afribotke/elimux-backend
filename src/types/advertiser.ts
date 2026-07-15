// ============================================
// ELIMUX AD PORTAL - TYPE DEFINITIONS
// Matches existing Supabase schema
// ============================================

export interface Advertiser {
    id: string;
    user_id?: string;
    company_name: string;
    company_email: string;
    company_phone?: string;
    company_website?: string;
    organization_type: string;
    tax_id?: string;
    billing_address?: Record<string, any>;
    status: 'pending' | 'approved' | 'rejected' | 'suspended';
    balance: number;
    total_spent: number;
    created_at: string;
    updated_at: string;
    approved_at?: string;
    approved_by?: string;
    password_hash?: string;
}

export interface AdCampaign {
    id: string;
    advertiser_id: string;
    name: string;
    description?: string;
    campaign_type: 'banner' | 'featured_listing' | 'sponsored_program' | 'search_sponsored' | 'homepage_hero';
    status: 'draft' | 'pending_review' | 'approved' | 'active' | 'paused' | 'completed' | 'rejected';
    target_countries?: string[];
    target_institution_types?: string[];
    target_categories?: string[];
    target_audience: 'all' | 'students' | 'parents' | 'agents';
    title: string;
    subtitle?: string;
    image_url?: string;
    destination_url: string;
    cta_text: string;
    budget: number;
    daily_budget?: number;
    duration_days?: number;
    start_date?: string;
    end_date?: string;
    billing_model: 'cpc' | 'cpm' | 'flat_fee';
    cpc_rate: number;
    cpm_rate: number;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    total_spent: number;
    is_powered_by?: boolean;
    review_notes?: string;
    reviewed_at?: string;
    reviewed_by?: string;
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
    user_id?: string;
    user_device_id?: string;
    ip_address?: string;
    user_agent?: string;
    country_code?: string;
    device_type?: string;
    page_url?: string;
    referrer?: string;
    created_at: string;
}

export interface AdPayment {
    id: string;
    advertiser_id: string;
    campaign_id?: string;
    amount: number;
    currency: string;
    payment_method: 'paystack' | 'mpesa' | 'bank_transfer';
    payment_status: 'pending' | 'completed' | 'failed' | 'refunded';
    transaction_id?: string;
    paystack_reference?: string;
    mpesa_checkout_request_id?: string;
    paystack_status?: string;
    metadata?: Record<string, any>;
    created_at: string;
    updated_at: string;
}

export interface CreateCampaignRequest {
    name: string;
    description?: string;
    campaign_type: AdCampaign['campaign_type'];
    target_countries?: string[];
    target_institution_types?: string[];
    target_categories?: string[];
    target_audience?: AdCampaign['target_audience'];
    title: string;
    subtitle?: string;
    image_url?: string;
    destination_url: string;
    cta_text?: string;
    budget: number;
    daily_budget?: number;
    start_date?: string;
    end_date?: string;
    duration_days?: number;
    billing_model?: AdCampaign['billing_model'];
    cpc_rate?: number;
    cpm_rate?: number;
}

export interface CampaignAnalytics {
    campaign_id: string;
    total_impressions: number;
    total_clicks: number;
    total_conversions: number;
    total_spent: number;
    ctr: number;
    cpc: number;
    daily_stats: {
        date: string;
        impressions: number;
        clicks: number;
        conversions: number;
        spend: number;
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
    subtitle?: string;
    image_url?: string;
    destination_url: string;
    cta_text: string;
    slot_name: string;
    tracking_url: string;
}

export interface CreatePaymentRequest {
    amount: number;
    currency?: string;
    campaign_id?: string;
}

export interface MpesaPaymentRequest {
    amount: number;
    phone_number: string;
    campaign_id?: string;
}
