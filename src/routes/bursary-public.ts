import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

function flattenFund(f: any, providerName: string | null, providerLogo: string | null) {
  return {
    id: f.id,
    tenantId: f.tenant_id,
    providerId: f.provider_id,
    name: f.name,
    description: f.description,
    fundType: f.fund_type,
    status: f.status,
    totalAmount: f.budget?.total ?? null,
    currency: f.budget?.currency ?? null,
    committed: f.budget?.committed ?? null,
    disbursed: f.budget?.disbursed ?? null,
    eligibilityRules: f.eligibility_rules ?? null,
    requiredDocuments: f.required_documents ?? null,
    deadline: f.application_window?.deadline ?? null,
    opensAt: f.application_window?.opens_at ?? null,
    providerName,
    providerLogo,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}

// GET /api/bursary/funds — List all open bursary funds across providers
router.get('/funds', async (req: Request, res: Response) => {
  try {
    const { data: funds, error: fundsError } = await supabase
      .from('bursary_funds')
      .select('*')
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    if (fundsError) throw fundsError;

    // provider_id is an optional override; the admin fund-create endpoint only
    // ever sets tenant_id, so that's the reliable "who owns this fund" field
    // (same convention bursary-providers.ts's GET /:slug/funds already uses).
    const providerIds = [...new Set((funds || []).map(f => f.provider_id || f.tenant_id).filter(Boolean))];
    const tenantIds = [...new Set((funds || []).map(f => f.tenant_id).filter(Boolean))];

    const [{ data: providers }, { data: branding }] = await Promise.all([
      providerIds.length
        ? supabase.from('tenants').select('id, name').in('id', providerIds)
        : Promise.resolve({ data: [] as any[] }),
      tenantIds.length
        ? supabase.from('tenant_branding').select('tenant_id, logo_url').in('tenant_id', tenantIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const providerMap = new Map((providers || []).map((p: any) => [p.id, p]));
    const brandingMap = new Map((branding || []).map((b: any) => [b.tenant_id, b]));

    const flattened = (funds || []).map(f =>
      flattenFund(f, providerMap.get(f.provider_id || f.tenant_id)?.name ?? null, brandingMap.get(f.tenant_id)?.logo_url ?? null)
    );

    return res.json({ funds: flattened });
  } catch (err: any) {
    console.error('[Bursary] List funds error:', err);
    return res.status(500).json({ error: 'Failed to load bursaries' });
  }
});

// GET /api/bursary/funds/:id — Single fund detail
router.get('/funds/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: fund, error: fundError } = await supabase
      .from('bursary_funds')
      .select('*')
      .eq('id', id)
      .single();

    if (fundError || !fund) {
      return res.status(404).json({ error: 'Bursary not found' });
    }

    const providerId = fund.provider_id || fund.tenant_id;
    const [{ data: provider }, { data: branding }] = await Promise.all([
      providerId
        ? supabase.from('tenants').select('id, name').eq('id', providerId).maybeSingle()
        : Promise.resolve({ data: null as any }),
      supabase.from('tenant_branding').select('logo_url').eq('tenant_id', fund.tenant_id).maybeSingle(),
    ]);

    return res.json({ fund: flattenFund(fund, provider?.name ?? null, branding?.logo_url ?? null) });
  } catch (err: any) {
    console.error('[Bursary] Fund detail error:', err);
    return res.status(500).json({ error: 'Failed to load bursary details' });
  }
});

// POST /api/bursary/apply — Student submits application
router.post('/apply', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { fund_id } = req.body;
    if (!fund_id) {
      return res.status(400).json({ error: 'fund_id is required' });
    }

    const { data: fund, error: fundError } = await supabase
      .from('bursary_funds')
      .select('id, tenant_id, status, application_window, name')
      .eq('id', fund_id)
      .single();

    if (fundError || !fund) {
      return res.status(404).json({ error: 'Bursary fund not found' });
    }

    if (fund.status !== 'open') {
      return res.status(400).json({ error: 'This bursary is not currently accepting applications' });
    }

    if (fund.application_window?.deadline && new Date(fund.application_window.deadline) < new Date()) {
      return res.status(400).json({ error: 'Application deadline has passed' });
    }

    // Find or create the applicant profile - bursary_applications.applicant_id
    // is a FK to bursary_applicants.id, not directly to auth.users.id.
    const { data: existingApplicant } = await supabase
      .from('bursary_applicants')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    let applicantId: string;
    if (existingApplicant) {
      applicantId = existingApplicant.id;
    } else {
      const { data: newApplicant, error: applicantError } = await supabase
        .from('bursary_applicants')
        .insert({
          user_id: user.id,
          tenant_id: fund.tenant_id,
          application_type: 'self',
        })
        .select('id')
        .single();

      if (applicantError || !newApplicant) {
        console.error('[Bursary] Applicant creation error:', applicantError);
        return res.status(500).json({ error: 'Failed to create applicant profile' });
      }
      applicantId = newApplicant.id;
    }

    const { data: existingApp } = await supabase
      .from('bursary_applications')
      .select('id')
      .eq('fund_id', fund_id)
      .eq('applicant_id', applicantId)
      .maybeSingle();

    if (existingApp) {
      return res.status(409).json({ error: 'You have already applied for this bursary' });
    }

    const { data: application, error: appError } = await supabase
      .from('bursary_applications')
      .insert({
        fund_id,
        applicant_id: applicantId,
        tenant_id: fund.tenant_id,
        status: 'submitted',
      })
      .select()
      .single();

    if (appError) {
      console.error('[Bursary] Application insert error:', appError);
      return res.status(500).json({ error: 'Failed to submit application' });
    }

    // Best-effort - a notification failure shouldn't fail an already-successful application
    try {
      await supabase.from('bursary_notifications').insert({
        user_id: user.id,
        type: 'status_update',
        title: 'Application submitted',
        message: `Your application for "${fund.name}" has been submitted.`,
        fund_id: fund_id,
        application_id: application.id,
      });
    } catch (notifyErr) {
      console.error('[Bursary] Notification insert error:', notifyErr);
    }

    return res.status(201).json({
      success: true,
      application_id: application.id,
      status: application.status,
      message: 'Application submitted successfully',
    });
  } catch (err: any) {
    console.error('[Bursary] Apply error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/bursary/applications/my — Current user's applications
router.get('/applications/my', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data: applicant } = await supabase
      .from('bursary_applicants')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!applicant) {
      return res.json({ applications: [] });
    }

    const { data: applications, error } = await supabase
      .from('bursary_applications')
      .select('*, fund:bursary_funds!fund_id(id, name, description, budget, application_window, status)')
      .eq('applicant_id', applicant.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Bursary] Fetch applications error:', error);
      return res.status(500).json({ error: 'Failed to fetch applications' });
    }

    const flattened = (applications || []).map((app: any) => ({
      id: app.id,
      applicantId: app.applicant_id,
      fundId: app.fund_id,
      tenantId: app.tenant_id,
      status: app.status,
      submissionData: app.submission_data,
      eligibilityScore: app.eligibility_score,
      fraudScore: app.fraud_score,
      documentStatus: app.document_status,
      createdAt: app.created_at,
      updatedAt: app.updated_at,
      fundName: app.fund?.name ?? null,
      fundDescription: app.fund?.description ?? null,
      fundAmount: app.fund?.budget?.total ?? null,
      fundCurrency: app.fund?.budget?.currency ?? null,
      fundDeadline: app.fund?.application_window?.deadline ?? null,
      fundStatus: app.fund?.status ?? null,
    }));

    return res.json({ applications: flattened });
  } catch (err: any) {
    console.error('[Bursary] Get applications error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function flattenApplicant(a: any) {
  const personal = a.personal_info || {};
  const academic = a.academic_info || {};
  return {
    id: a.id,
    fullName: personal.full_name ?? null,
    email: personal.email ?? null,
    phone: personal.phone ?? null,
    dateOfBirth: personal.date_of_birth ?? null,
    institution: academic.institution ?? null,
    course: academic.course ?? null,
    yearOfStudy: academic.year_of_study ?? null,
    gpa: academic.gpa ?? null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// GET /api/bursary/applicant/me — Get the current user's applicant profile
router.get('/applicant/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data: applicant } = await supabase
      .from('bursary_applicants')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    return res.json({ profile: applicant ? flattenApplicant(applicant) : null });
  } catch (err: any) {
    console.error('[Bursary] Get applicant profile error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/bursary/applicant/me — Update (or create) the current user's applicant profile
router.patch('/applicant/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { fullName, email, phone, dateOfBirth, institution, course, yearOfStudy, gpa } = req.body;

    const personalInfo = {
      ...(fullName !== undefined ? { full_name: fullName } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(dateOfBirth !== undefined ? { date_of_birth: dateOfBirth } : {}),
    };
    const academicInfo = {
      ...(institution !== undefined ? { institution } : {}),
      ...(course !== undefined ? { course } : {}),
      ...(yearOfStudy !== undefined ? { year_of_study: yearOfStudy } : {}),
      ...(gpa !== undefined ? { gpa } : {}),
    };

    const { data: existing } = await supabase
      .from('bursary_applicants')
      .select('id, personal_info, academic_info')
      .eq('user_id', user.id)
      .maybeSingle();

    let applicant;
    if (existing) {
      const { data, error } = await supabase
        .from('bursary_applicants')
        .update({
          personal_info: { ...(existing.personal_info || {}), ...personalInfo },
          academic_info: { ...(existing.academic_info || {}), ...academicInfo },
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw error;
      applicant = data;
    } else {
      const { data, error } = await supabase
        .from('bursary_applicants')
        .insert({
          user_id: user.id,
          tenant_id: null,
          application_type: 'self',
          personal_info: personalInfo,
          academic_info: academicInfo,
        })
        .select('*')
        .single();
      if (error) throw error;
      applicant = data;
    }

    return res.json({ profile: flattenApplicant(applicant) });
  } catch (err: any) {
    console.error('[Bursary] Update applicant profile error:', err);
    return res.status(500).json({ error: 'Failed to save profile' });
  }
});

// POST /api/bursary/bookmarks — Bookmark a fund
router.post('/bookmarks', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { fund_id } = req.body;
    if (!fund_id) {
      return res.status(400).json({ error: 'fund_id is required' });
    }

    const { data, error } = await supabase
      .from('bursary_bookmarks')
      .upsert({ user_id: user.id, fund_id }, { onConflict: 'user_id,fund_id' })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, bookmark: { id: data.id, fundId: data.fund_id, createdAt: data.created_at } });
  } catch (err: any) {
    console.error('[Bursary] Add bookmark error:', err);
    return res.status(500).json({ error: 'Failed to save bookmark' });
  }
});

// DELETE /api/bursary/bookmarks/:fundId — Remove a bookmark
router.delete('/bookmarks/:fundId', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { fundId } = req.params;
    const { error } = await supabase.from('bursary_bookmarks').delete().eq('user_id', user.id).eq('fund_id', fundId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[Bursary] Remove bookmark error:', err);
    return res.status(500).json({ error: 'Failed to remove bookmark' });
  }
});

// GET /api/bursary/bookmarks — List current user's bookmarked funds
router.get('/bookmarks', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data: bookmarks, error } = await supabase
      .from('bursary_bookmarks')
      .select('id, fund_id, created_at, fund:bursary_funds!fund_id(*)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const fundRows = (bookmarks || []).map((b: any) => b.fund).filter(Boolean);
    const providerIds = [...new Set(fundRows.map((f: any) => f.provider_id || f.tenant_id).filter(Boolean))];
    const tenantIds = [...new Set(fundRows.map((f: any) => f.tenant_id).filter(Boolean))];

    const [{ data: providers }, { data: branding }] = await Promise.all([
      providerIds.length ? supabase.from('tenants').select('id, name').in('id', providerIds) : Promise.resolve({ data: [] as any[] }),
      tenantIds.length ? supabase.from('tenant_branding').select('tenant_id, logo_url').in('tenant_id', tenantIds) : Promise.resolve({ data: [] as any[] }),
    ]);
    const providerMap = new Map((providers || []).map((p: any) => [p.id, p]));
    const brandingMap = new Map((branding || []).map((b: any) => [b.tenant_id, b]));

    const flattened = (bookmarks || [])
      .filter((b: any) => b.fund)
      .map((b: any) => ({
        bookmarkId: b.id,
        bookmarkedAt: b.created_at,
        fund: flattenFund(b.fund, providerMap.get(b.fund.provider_id || b.fund.tenant_id)?.name ?? null, brandingMap.get(b.fund.tenant_id)?.logo_url ?? null),
      }));

    return res.json({ bookmarks: flattened });
  } catch (err: any) {
    console.error('[Bursary] List bookmarks error:', err);
    return res.status(500).json({ error: 'Failed to load bookmarks' });
  }
});

// GET /api/bursary/notifications — List current user's notifications
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data, error } = await supabase
      .from('bursary_notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    const notifications = (data || []).map((n: any) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      fundId: n.fund_id,
      applicationId: n.application_id,
      isRead: n.is_read,
      createdAt: n.created_at,
    }));

    return res.json({ notifications });
  } catch (err: any) {
    console.error('[Bursary] List notifications error:', err);
    return res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// PATCH /api/bursary/notifications/:id/read — Mark a notification as read
router.patch('/notifications/:id/read', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { id } = req.params;
    const { error } = await supabase
      .from('bursary_notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[Bursary] Mark notification read error:', err);
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

// GET /api/bursary/alert-preferences — Get current user's alert preferences
router.get('/alert-preferences', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { data } = await supabase
      .from('bursary_alert_preferences')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    return res.json({
      preferences: data
        ? {
            alertTypes: data.alert_types || [],
            fieldOfStudy: data.field_of_study,
            minAmount: data.min_amount,
            maxAmount: data.max_amount,
          }
        : { alertTypes: ['deadline', 'new_match'], fieldOfStudy: null, minAmount: null, maxAmount: null },
    });
  } catch (err: any) {
    console.error('[Bursary] Get alert preferences error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/bursary/alert-preferences — Update (or create) alert preferences
router.patch('/alert-preferences', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const { alertTypes, fieldOfStudy, minAmount, maxAmount } = req.body;

    const { data, error } = await supabase
      .from('bursary_alert_preferences')
      .upsert(
        {
          user_id: user.id,
          alert_types: alertTypes ?? ['deadline', 'new_match'],
          field_of_study: fieldOfStudy ?? null,
          min_amount: minAmount ?? null,
          max_amount: maxAmount ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      )
      .select()
      .single();

    if (error) throw error;

    return res.json({
      preferences: {
        alertTypes: data.alert_types || [],
        fieldOfStudy: data.field_of_study,
        minAmount: data.min_amount,
        maxAmount: data.max_amount,
      },
    });
  } catch (err: any) {
    console.error('[Bursary] Update alert preferences error:', err);
    return res.status(500).json({ error: 'Failed to save preferences' });
  }
});

export default router;
