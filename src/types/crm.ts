export type CRMEntityType = 'university' | 'school_public' | 'school_private' | 'company' | 'government' | 'partner' | 'other';
export type CRMStatus = 'new' | 'contacted' | 'responded' | 'negotiating' | 'onboarded' | 'active' | 'dormant' | 'rejected' | 'blacklisted';
export type CRMPriority = 'low' | 'medium' | 'high';
export type CRMChannel = 'email' | 'sms' | 'whatsapp';
export type CRMMessageStatus = 'queued' | 'pending_approval' | 'sent' | 'delivered' | 'read' | 'opened' | 'clicked' | 'replied' | 'failed' | 'bounced' | 'suppressed';
export type CRMTeamRole = 'super_admin' | 'manager' | 'sales_rep' | 'viewer';
export type CRMMessageCategory = 'onboarding' | 'followup' | 'reminder' | 'negotiation' | 're_engagement' | 'announcement' | 'custom';

export interface CRMContact {
  id: string;
  entity_type: CRMEntityType;
  name: string;
  slug?: string;
  linked_institution_id?: string;
  linked_school_id?: string;
  linked_employer_id?: string;
  legacy_employer_name_id?: string;
  legacy_employer_outreach_id?: string;
  country?: string;
  county?: string;
  constituency?: string;
  town?: string;
  email?: string;
  phone?: string;
  whatsapp_number?: string;
  website?: string;
  status: CRMStatus;
  priority: CRMPriority;
  assigned_to?: string;
  assigned_by?: string;
  assigned_at?: string;
  last_contact_at?: string;
  last_contact_via?: string;
  next_followup_at?: string;
  contact_count: number;
  response_count: number;
  source: string;
  notes?: string;
  tags?: string[];
  research_data?: Record<string, unknown>;
  enriched_at?: string;
  enrichment_data?: Record<string, unknown>;
  unsubscribed_email: boolean;
  unsubscribed_sms: boolean;
  unsubscribed_whatsapp: boolean;
  consent_recorded_at?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CRMContactPerson {
  id: string;
  contact_id: string;
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  is_primary?: boolean;
  is_decision_maker?: boolean;
  notes?: string;
  created_at: string;
}

export interface CRMMessageTemplate {
  id: string;
  name: string;
  category: CRMMessageCategory;
  channel_email: boolean;
  subject_email?: string;
  body_html?: string;
  body_text?: string;
  channel_sms: boolean;
  body_sms?: string;
  channel_whatsapp: boolean;
  body_whatsapp?: string;
  target_entity_types?: CRMEntityType[];
  created_by?: string;
  is_active: boolean;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface CRMMessage {
  id: string;
  contact_id: string;
  person_id?: string;
  template_id?: string;
  channel: CRMChannel;
  subject?: string;
  body: string;
  status: CRMMessageStatus;
  provider?: string;
  provider_msg_id?: string;
  sent_at?: string;
  delivered_at?: string;
  read_at?: string;
  opened_at?: string;
  clicked_at?: string;
  replied_at?: string;
  failed_at?: string;
  fail_reason?: string;
  sent_by?: string;
  ip_address?: string;
  user_agent?: string;
  cost_kes?: number;
  created_at: string;
}

export interface CRMActivity {
  id: string;
  user_id?: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
  ip_address?: string;
  created_at: string;
}

export interface CRMTeamMember {
  id: string;
  user_id: string;
  role: CRMTeamRole;
  reports_to?: string;
  county_scope?: string[];
  entity_type_scope?: CRMEntityType[];
  is_active: boolean;
  created_by?: string;
  created_at: string;
}
