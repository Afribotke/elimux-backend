import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { createHash } from 'crypto';
import { publicRegistrationRateLimiter } from '../middleware/rate-limit';

const router = Router();

// POST /api/bursary/providers/register
// Public: No auth required
router.post('/register', publicRegistrationRateLimiter, async (req, res) => {
  const {
    name,
    type,
    registrationNumber,
    email,
    phone,
    county,
    subCounty,
    ward,
    address,
    adminName,
    adminEmail,
    adminPhone,
  } = req.body;

  // Validation
  if (!name || !type || !email || !phone || !adminName || !adminEmail) {
    return res.status(400).json({ error: 'Missing required fields: name, type, email, phone, adminName, adminEmail' });
  }

  const validTypes = ['county', 'ngcdf', 'ward', 'ngo', 'csr', 'foundation', 'alumni', 'school', 'individual'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
  }

  // Generate slug from name
  const baseSlug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  // Ensure unique slug
  let slug = baseSlug;
  let suffix = 1;
  while (true) {
    const { data: existing } = await supabase.from('tenants').select('id').eq('slug', slug).single();
    if (!existing) break;
    slug = `${baseSlug}-${suffix}`;
    suffix++;
  }

  try {
    // Create tenant. Retries on a slug unique-violation (23505) rather than
    // trusting the pre-check above alone - the check-then-insert above has
    // a real TOCTOU race under concurrent identical-name registrations, same
    // class of race routes/referrals.ts already retries around for its own
    // generated codes.
    let tenant: any = null;
    let tErr: any = null;
    for (let attempt = 0; attempt < 5 && !tenant; attempt++) {
      const { data, error } = await supabase
        .from('tenants')
        .insert({
          slug,
          name,
          type,
          registration_number: registrationNumber,
          status: 'pending',
          verification_status: 'pending',
          contact: { email, phone, county, sub_county: subCounty, ward, address },
          active_modules: ['MOD_CORE', 'MOD_AI_ELIGIBILITY', 'MOD_AI_FORENSICS', 'MOD_AI_FRAUD', 'MOD_DISBURSE_MPESA', 'MOD_DISBURSE_EXTERNAL', 'MOD_VERIFY_INSTITUTION', 'MOD_SCHOOL_MEDIATED', 'MOD_GUARDIAN_CONSENT', 'MOD_OFFLINE_QUEUE'],
          module_settings: {},
          budget_settings: { total: 0, committed: 0, disbursed: 0, currency: 'KES' },
        })
        .select()
        .single();

      if (!error) {
        tenant = data;
      } else if (error.code === '23505') {
        tErr = error;
        slug = `${baseSlug}-${suffix}`;
        suffix++;
        continue;
      } else {
        throw error;
      }
    }

    if (!tenant) throw tErr || new Error('Failed to generate a unique provider slug');

    // Create default branding. tenant_branding has no `name` column (the
    // organization name already lives on tenants.name) - only
    // email_sender_name carries it here, matching the real live schema.
    const { error: bErr } = await supabase
      .from('tenant_branding')
      .insert({
        tenant_id: tenant.id,
        primary_color: '#0052CC',
        secondary_color: '#FF6B00',
        font_family: 'Inter',
        language: 'en',
        support_email: email,
        support_phone: phone,
        meta_title: `${name} - Bursary Portal`,
        meta_description: `Apply for bursaries and funding opportunities from ${name}`,
        email_sender_name: name,
      });

    if (bErr) throw bErr;

    // Generate admin invite token
    const inviteToken = createHash('sha256')
      .update(`${tenant.id}-${adminEmail}-${Date.now()}`)
      .digest('hex')
      .slice(0, 32);

    // Store invite (in a real system, send email with link)
    // For now, return the invite token in response (founder will distribute manually)
    console.log(`[Provider Onboarding] Admin invite for ${name}: token=${inviteToken}, email=${adminEmail}`);

    return res.status(201).json({
      success: true,
      message: 'Provider registered successfully. Pending verification.',
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        type: tenant.type,
        status: tenant.status,
        portalUrl: `https://${tenant.slug}.bursary.elimux.ke`,
      },
      adminInvite: {
        email: adminEmail,
        token: inviteToken,
        // In production, this would be sent via email instead of returned
      },
    });
  } catch (error: any) {
    console.error('[Provider Registration] Error:', error);
    return res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

// GET /api/bursary/providers/:slug
// Public: View provider public profile
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, slug, name, type, status, verification_status, contact, created_at')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();

  if (!tenant) return res.status(404).json({ error: 'Provider not found' });

  const { data: branding } = await supabase
    .from('tenant_branding')
    .select('*')
    .eq('tenant_id', tenant.id)
    .single();

  return res.status(200).json({
    ...tenant,
    branding: branding || {},
  });
});

// GET /api/bursary/providers/:slug/funds
// Public: View open funds for this provider
router.get('/:slug/funds', async (req, res) => {
  const { slug } = req.params;

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();

  if (!tenant) return res.status(404).json({ error: 'Provider not found' });

  const { data: funds } = await supabase
    .from('bursary_funds')
    .select('id, name, description, fund_type, status, budget, eligibility_rules, application_window, created_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false });

  return res.status(200).json({ funds: funds || [] });
});

export default router;
