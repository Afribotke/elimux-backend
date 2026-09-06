import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { sendTemplatedEmail } from '../lib/email';
import { adminAuth } from '../middleware/auth';

const router = Router();

// GET /api/crm/contacts — list with filters
router.get('/contacts', adminAuth, async (req, res) => {
  try {
    const { entity_type, status, county, assigned_to, country_relevance, search, page = '1', limit = '50' } = req.query;

    let query = supabase
      .from('crm_contacts')
      .select('*', { count: 'exact' });

    if (entity_type) query = query.eq('entity_type', entity_type);
    if (status) query = query.eq('status', status);
    if (county) query = query.eq('county', county);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);
    if (country_relevance) query = query.eq('country_relevance', country_relevance);
    if (search) query = query.ilike('name', `%${search}%`);

    const from = (parseInt(page as string) - 1) * parseInt(limit as string);
    const to = from + parseInt(limit as string) - 1;

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    res.json({
      data,
      meta: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit as string)),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/contacts/:id — single contact with people
router.get('/contacts/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: contact, error: contactError } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', id)
      .single();

    if (contactError) throw contactError;

    const { data: people, error: peopleError } = await supabase
      .from('crm_contact_people')
      .select('*')
      .eq('contact_id', id);

    if (peopleError) throw peopleError;

    const { data: messages, error: msgError } = await supabase
      .from('crm_messages')
      .select('*')
      .eq('contact_id', id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (msgError) throw msgError;

    res.json({ contact, people: people || [], messages: messages || [] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/crm/contacts/:id/people — add a key person to a contact
// (Cycle 163 note: this route already existed from an earlier cycle. Cycle
// 163's brief re-specified the same path+method with richer validation and
// activity metadata - appending it as a second handler would have been dead
// code, since Express only ever invokes the first match for an identical
// path+method. Merged the brief's improvements into this existing handler
// in place instead of duplicating it.)
router.post('/contacts/:id/people', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, title, email, phone, whatsapp, is_primary, is_decision_maker, notes, created_by } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data: person, error } = await supabase
      .from('crm_contact_people')
      .insert({
        contact_id: id,
        name,
        title: title || null,
        email: email || null,
        phone: phone || null,
        whatsapp: whatsapp || null,
        is_primary: is_primary || false,
        is_decision_maker: is_decision_maker || false,
        notes: notes || null,
      })
      .select()
      .single();

    if (error) throw error;

    // If this person has email/phone and contact had none, log it
    const { data: contact } = await supabase
      .from('crm_contacts')
      .select('email, phone, whatsapp_number')
      .eq('id', id)
      .single();

    const gainedChannel = !contact?.email && email ? 'email' :
                          !contact?.phone && phone ? 'phone' :
                          !contact?.whatsapp_number && whatsapp ? 'whatsapp' : null;

    await supabase.from('crm_activities').insert({
      user_id: created_by || null,
      action: 'contact_person_added',
      entity_type: 'contact',
      entity_id: id,
      metadata: {
        person_name: name,
        person_id: person.id,
        gained_channel: gainedChannel,
        has_email: !!email,
        has_phone: !!phone,
        has_whatsapp: !!whatsapp,
      },
    });

    res.json(person);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/templates — list templates
router.get('/templates', adminAuth, async (req, res) => {
  try {
    const { entity_type, category } = req.query;

    let query = supabase
      .from('crm_message_templates')
      .select('*')
      .eq('is_active', true);

    if (category) query = query.eq('category', category);

    if (entity_type) {
      query = query.or(`target_entity_types.cs.{${entity_type}},target_entity_types.is.null`);
    }

    const { data, error } = await query.order('usage_count', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/crm/templates — create a template (needed for the admin CRM
// template-management UI - GET-only until now, no way to write one)
router.post('/templates', adminAuth, async (req, res) => {
  try {
    const {
      name, category, channel_email, subject_email, body_html, body_text,
      channel_sms, body_sms, channel_whatsapp, body_whatsapp,
      target_entity_types, created_by,
    } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'name and category are required' });
    }

    const { data, error } = await supabase
      .from('crm_message_templates')
      .insert({
        name,
        category,
        channel_email: !!channel_email,
        subject_email: subject_email || null,
        body_html: body_html || null,
        body_text: body_text || null,
        channel_sms: !!channel_sms,
        body_sms: body_sms || null,
        channel_whatsapp: !!channel_whatsapp,
        body_whatsapp: body_whatsapp || null,
        target_entity_types: target_entity_types || null,
        created_by: created_by || null,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /api/crm/templates/:id — edit a template
router.patch('/templates/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, category, channel_email, subject_email, body_html, body_text,
      channel_sms, body_sms, channel_whatsapp, body_whatsapp,
      target_entity_types, is_active,
    } = req.body;

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (category !== undefined) updates.category = category;
    if (channel_email !== undefined) updates.channel_email = channel_email;
    if (subject_email !== undefined) updates.subject_email = subject_email || null;
    if (body_html !== undefined) updates.body_html = body_html || null;
    if (body_text !== undefined) updates.body_text = body_text || null;
    if (channel_sms !== undefined) updates.channel_sms = channel_sms;
    if (body_sms !== undefined) updates.body_sms = body_sms || null;
    if (channel_whatsapp !== undefined) updates.channel_whatsapp = channel_whatsapp;
    if (body_whatsapp !== undefined) updates.body_whatsapp = body_whatsapp || null;
    if (target_entity_types !== undefined) updates.target_entity_types = target_entity_types || null;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from('crm_message_templates')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/crm/send-email — send templated email
router.post('/send-email', adminAuth, async (req, res) => {
  try {
    const { contact_id, person_id, template_id, sent_by, base_url } = req.body;

    const { data: contact, error: contactError } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', contact_id)
      .single();

    if (contactError || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    if (!contact.email && !person_id) {
      return res.status(400).json({
        error: 'Contact has no email. Add a contact person with email first.',
        needs_enrichment: true
      });
    }

    let person = null;
    if (person_id) {
      const { data: p, error: personError } = await supabase
        .from('crm_contact_people')
        .select('*')
        .eq('id', person_id)
        .single();
      if (!personError && p) person = p;
    }

    const { data: template, error: templateError } = await supabase
      .from('crm_message_templates')
      .select('*')
      .eq('id', template_id)
      .single();

    if (templateError || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // auth.users isn't a public-schema table PostgREST can .from() — fetch
    // via the admin API, same pattern used everywhere else in this codebase
    // (auth.ts, attachments.ts, employer-evaluations.ts, etc.)
    let repName = 'ElimuX Team';
    if (sent_by) {
      const { data: senderData } = await supabase.auth.admin.getUserById(sent_by).catch(() => ({ data: null }) as any);
      const metaName = senderData?.user?.user_metadata?.name;
      if (metaName) repName = metaName;
    }

    const variables = {
      contact_name: contact.name,
      person_name: person?.name || 'Sir/Madam',
      county: contact.county || 'your county',
      slug: contact.slug || '',
      assigned_rep_name: repName,
      elimux_url: 'https://www.elimux.ke',
    };

    const result = await sendTemplatedEmail(
      template,
      contact,
      person,
      variables,
      sent_by,
      base_url || 'https://www.elimux.ke',
      supabase
    );

    if (result.success) {
      await supabase.rpc('increment_template_usage', { template_id });

      await supabase.from('crm_activities').insert({
        user_id: sent_by,
        action: 'email_sent',
        entity_type: 'contact',
        entity_id: contact_id,
        metadata: { template_id, template_name: template.name, channel: 'email' },
      });

      res.json({ success: true, messageId: result.messageId });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /api/crm/contacts/:id — update contact with research/enrichment data
router.patch('/contacts/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('crm_contacts')
      .update({
        ...updates,
        enriched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: updates.updated_by,
      action: 'contact_enriched',
      entity_type: 'contact',
      entity_id: id,
      metadata: { fields_updated: Object.keys(updates) },
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/stats/dashboard — executive dashboard data
router.get('/stats/dashboard', adminAuth, async (req, res) => {
  try {
    const { data: typeCounts } = await supabase.rpc('get_crm_stats_by_type');
    const { data: countyCounts } = await supabase.rpc('get_crm_stats_by_county');
    const { data: messageStats } = await supabase.rpc('get_crm_message_stats');

    res.json({
      by_type: typeCounts || [],
      by_county: countyCounts || [],
      messages: messageStats || [],
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ============================================
// SMS Routes (appended to existing crm.ts)
// ============================================

import { sendTemplatedSms, sendTemplatedMessage } from '../lib/email';

// POST /api/crm/send-sms — send templated SMS
router.post('/send-sms', adminAuth, async (req, res) => {
  try {
    const { contact_id, person_id, template_id, sent_by } = req.body;

    const { data: contact, error: contactError } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', contact_id)
      .single();

    if (contactError || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    let person = null;
    if (person_id) {
      const { data: p } = await supabase
        .from('crm_contact_people')
        .select('*')
        .eq('id', person_id)
        .single();
      if (p) person = p;
    }

    const { data: template } = await supabase
      .from('crm_message_templates')
      .select('*')
      .eq('id', template_id)
      .single();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { data: senderUser } = await supabase.auth.admin.getUserById(sent_by);
    const senderName = senderUser?.user?.user_metadata?.name || 'ElimuX Team';

    const variables = {
      contact_name: contact.name,
      person_name: person?.name || 'Sir/Madam',
      county: contact.county || 'your county',
      slug: contact.slug || '',
      assigned_rep_name: senderName,
      elimux_url: 'https://www.elimux.ke',
    };

    const result = await sendTemplatedSms(template, contact, person, variables, sent_by, supabase);

    if (result.success) {
      await supabase.rpc('increment_template_usage', { template_id });
      await supabase.from('crm_activities').insert({
        user_id: sent_by,
        action: 'sms_sent',
        entity_type: 'contact',
        entity_id: contact_id,
        metadata: { template_id, template_name: template.name, channel: 'sms' },
      });
      res.json({ success: true, messageId: result.messageId, channel: 'sms' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/crm/send — smart channel router (email → SMS → enrichment flag)
router.post('/send', adminAuth, async (req, res) => {
  try {
    const { contact_id, person_id, template_id, sent_by, base_url } = req.body;

    const { data: contact, error: contactError } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', contact_id)
      .single();

    if (contactError || !contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    let person = null;
    if (person_id) {
      const { data: p } = await supabase
        .from('crm_contact_people')
        .select('*')
        .eq('id', person_id)
        .single();
      if (p) person = p;
    }

    const { data: template } = await supabase
      .from('crm_message_templates')
      .select('*')
      .eq('id', template_id)
      .single();

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { data: senderUser } = await supabase.auth.admin.getUserById(sent_by);
    const senderName = senderUser?.user?.user_metadata?.name || 'ElimuX Team';

    const variables = {
      contact_name: contact.name,
      person_name: person?.name || 'Sir/Madam',
      county: contact.county || 'your county',
      slug: contact.slug || '',
      assigned_rep_name: senderName,
      elimux_url: 'https://www.elimux.ke',
    };

    const result = await sendTemplatedMessage(template, contact, person, variables, sent_by, base_url || 'https://www.elimux.ke', supabase);

    if (result.success && result.channel) {
      await supabase.rpc('increment_template_usage', { template_id });
      await supabase.from('crm_activities').insert({
        user_id: sent_by,
        action: `${result.channel}_sent`,
        entity_type: 'contact',
        entity_id: contact_id,
        metadata: { template_id, template_name: template.name, channel: result.channel },
      });
      res.json({ success: true, messageId: result.messageId, channel: result.channel });
    } else if (result.channel === 'none') {
      res.status(400).json({
        success: false,
        error: result.error,
        needs_enrichment: true,
        contact_id,
      });
    } else {
      res.status(500).json({ success: false, error: result.error, channel: result.channel });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/contacts/needs-enrichment — list contacts missing all channels
router.get('/contacts/needs-enrichment', adminAuth, async (req, res) => {
  try {
    const { entity_type, page = '1', limit = '50' } = req.query;

    let query = supabase
      .from('crm_contacts')
      .select('*', { count: 'exact' })
      .is('email', null)
      .is('phone', null)
      .is('whatsapp_number', null)
      .not('id', 'in', (
        supabase.from('crm_contact_people').select('contact_id').not('email', 'is', null)
          .or('phone.not.is.null,whatsapp.not.is.null')
      ));

    if (entity_type) query = query.eq('entity_type', entity_type);

    const from = (parseInt(page as string) - 1) * parseInt(limit as string);
    const to = from + parseInt(limit as string) - 1;

    const { data, error, count } = await query
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    res.json({
      data: data || [],
      meta: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit as string)),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ============================================
// Team Management Routes (appended to crm.ts)
// ============================================

// GET /api/crm/team — list team members with user details
router.get('/team', adminAuth, async (req, res) => {
  try {
    const { data: team, error } = await supabase
      .from('crm_team')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // auth.users isn't exposed to PostgREST (confirmed live: embedding
    // user:user_id(...) here 500s with "Could not find a relationship" -
    // same class of bug as Cycle 160's `.from('auth.users')` call), so user
    // details are fetched per-row via the admin API instead, same pattern
    // already used elsewhere in this codebase (employer-evaluations.ts).
    const enriched = await Promise.all(
      (team || []).map(async (member) => {
        const { data: userData } = await supabase.auth.admin.getUserById(member.user_id);
        return {
          ...member,
          user: userData?.user
            ? {
                id: userData.user.id,
                email: userData.user.email,
                name: userData.user.user_metadata?.name,
                user_role: userData.user.user_metadata?.role,
              }
            : null,
        };
      })
    );

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/crm/team — add a team member
router.post('/team', adminAuth, async (req, res) => {
  try {
    const { user_id, role, reports_to, county_scope, entity_type_scope, created_by } = req.body;

    if (!user_id || !role) {
      return res.status(400).json({ error: 'user_id and role are required' });
    }

    const { data, error } = await supabase
      .from('crm_team')
      .insert({
        user_id,
        role,
        reports_to: reports_to || null,
        county_scope: county_scope || null,
        entity_type_scope: entity_type_scope || null,
        is_active: true,
        created_by: created_by || null,
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: created_by || null,
      action: 'team_member_added',
      entity_type: 'user',
      entity_id: user_id,
      metadata: { role, reports_to },
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /api/crm/team/:id — deactivate a team member
router.delete('/team/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { removed_by } = req.body;

    const { data, error } = await supabase
      .from('crm_team')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: removed_by || null,
      action: 'team_member_removed',
      entity_type: 'user',
      entity_id: data.user_id,
      metadata: { role: data.role },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ============================================
// Assignment & Activity Routes
// ============================================

// PATCH /api/crm/contacts/:id/assign — assign contact to a rep
router.patch('/contacts/:id/assign', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { assigned_to, assigned_by } = req.body;

    const { data: contact, error } = await supabase
      .from('crm_contacts')
      .update({
        assigned_to,
        assigned_by: assigned_by || null,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: assigned_by || null,
      action: 'contact_assigned',
      entity_type: 'contact',
      entity_id: id,
      metadata: { assigned_to, previous_assigned_to: contact.assigned_to },
    });

    res.json(contact);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/activities — activity feed with filters
router.get('/activities', adminAuth, async (req, res) => {
  try {
    const { user_id, action, entity_type, entity_id, page = '1', limit = '50' } = req.query;

    let query = supabase
      .from('crm_activities')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (user_id) query = query.eq('user_id', user_id);
    if (action) query = query.eq('action', action);
    if (entity_type) query = query.eq('entity_type', entity_type);
    if (entity_id) query = query.eq('entity_id', entity_id);

    const from = (parseInt(page as string) - 1) * parseInt(limit as string);
    const to = from + parseInt(limit as string) - 1;

    const { data, error, count } = await query.range(from, to);

    if (error) throw error;

    // Same auth.users-not-exposed constraint as GET /team above - enrich
    // per unique user_id via the admin API instead of a broken embed.
    const uniqueUserIds = [...new Set((data || []).map((a) => a.user_id).filter(Boolean))];
    const userMap = new Map<string, { email?: string; name?: string }>();
    await Promise.all(
      uniqueUserIds.map(async (uid) => {
        const { data: userData } = await supabase.auth.admin.getUserById(uid as string);
        if (userData?.user) {
          userMap.set(uid as string, {
            email: userData.user.email,
            name: userData.user.user_metadata?.name,
          });
        }
      })
    );
    const enriched = (data || []).map((a) => ({
      ...a,
      user: a.user_id ? userMap.get(a.user_id) || null : null,
    }));

    res.json({
      data: enriched,
      meta: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total: count || 0,
        pages: Math.ceil((count || 0) / parseInt(limit as string)),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/stats/team — per-rep performance metrics
router.get('/stats/team', adminAuth, async (req, res) => {
  try {
    const { data: repStats, error } = await supabase.rpc('get_crm_team_stats');

    if (error) throw error;

    res.json(repStats || []);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ============================================
// Contact Enrichment Routes (appended to crm.ts)
// ============================================

// PATCH /api/crm/contacts/:id/enrich — update contact channel data
router.patch('/contacts/:id/enrich', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, phone, whatsapp_number, website, county, constituency, town, notes, updated_by } = req.body;

    // Build update object with only provided fields
    const updates: Record<string, any> = {
      enriched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (email !== undefined) updates.email = email || null;
    if (phone !== undefined) updates.phone = phone || null;
    if (whatsapp_number !== undefined) updates.whatsapp_number = whatsapp_number || null;
    if (website !== undefined) updates.website = website || null;
    if (county !== undefined) updates.county = county || null;
    if (constituency !== undefined) updates.constituency = constituency || null;
    if (town !== undefined) updates.town = town || null;
    if (notes !== undefined) updates.notes = notes || null;

    const { data: contact, error } = await supabase
      .from('crm_contacts')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: updated_by || null,
      action: 'contact_enriched',
      entity_type: 'contact',
      entity_id: id,
      metadata: { fields_updated: Object.keys(updates).filter(k => k !== 'enriched_at' && k !== 'updated_at') },
    });

    res.json(contact);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/crm/contacts/:id/people — list key people for a contact
router.get('/contacts/:id/people', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('crm_contact_people')
      .select('*')
      .eq('contact_id', id)
      .order('is_primary', { ascending: false })
      .order('is_decision_maker', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /api/crm/contacts/people/:personId — remove a key person
router.delete('/contacts/people/:personId', adminAuth, async (req, res) => {
  try {
    const { personId } = req.params;

    const { data: person, error: findError } = await supabase
      .from('crm_contact_people')
      .select('contact_id, name')
      .eq('id', personId)
      .single();

    if (findError || !person) {
      return res.status(404).json({ error: 'Contact person not found' });
    }

    const { error } = await supabase
      .from('crm_contact_people')
      .delete()
      .eq('id', personId);

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: null,
      action: 'contact_person_removed',
      entity_type: 'contact',
      entity_id: person.contact_id,
      metadata: { person_name: person.name, person_id: personId },
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/crm/contacts/bulk-enrich — bulk update contacts from research data
router.post('/contacts/bulk-enrich', adminAuth, async (req, res) => {
  try {
    const { updates, updated_by } = req.body;
    // updates: array of { id, email?, phone?, whatsapp_number?, notes? }

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array required' });
    }

    if (updates.length > 100) {
      return res.status(400).json({ error: 'Max 100 contacts per bulk update' });
    }

    const results = [];
    const errors = [];

    for (const item of updates) {
      const { id, ...fields } = item;
      const updateObj: Record<string, any> = {
        enriched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (fields.email !== undefined) updateObj.email = fields.email || null;
      if (fields.phone !== undefined) updateObj.phone = fields.phone || null;
      if (fields.whatsapp_number !== undefined) updateObj.whatsapp_number = fields.whatsapp_number || null;
      if (fields.notes !== undefined) updateObj.notes = fields.notes || null;

      const { data, error } = await supabase
        .from('crm_contacts')
        .update(updateObj)
        .eq('id', id)
        .select('id, name, email, phone')
        .single();

      if (error) {
        errors.push({ id, error: error.message });
      } else {
        results.push(data);
      }
    }

    await supabase.from('crm_activities').insert({
      user_id: updated_by || null,
      action: 'bulk_enrich',
      entity_type: 'contact',
      entity_id: null,
      metadata: { count: results.length, errors: errors.length },
    });

    res.json({ success: results.length, failed: errors.length, results, errors });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ============================================
// Website Contact Scraper (appended to crm.ts)
// ============================================

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?254|0)\s*[17]\d{2}\s*\d{3}\s*\d{3}|(?:\+?254|0)\s*11\s*\d{3}\s*\d{4}|(?:\+?254|0)[17]\d{8}|(?:\+?254|0)11\d{7}/g;

const FALSE_POSITIVE_DOMAINS = new Set([
  'example.com', 'test.com', 'domain.com', 'email.com', 'mail.com',
  'yourdomain.com', 'company.com', 'website.com', 'localhost',
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', // personal emails on websites are still valid leads
  // Live-testing (Cycle 165) found these as actual matches: unfilled contact-
  // form placeholder text and JS error-tracking beacons embedded in page HTML.
  'youremail.com', 'youremail.coom', 'yourname.com', 'sample.com',
  'sentry.wixpress.com', 'sentry-next.wixpress.com', 'wixpress.com',
  // Cycle 166 spot-check found these live on parked/expired domains: the
  // scraper picks up the domain marketplace's own contact address instead of
  // detecting the site isn't the real company at all.
  'domainmarket.com', 'brandbucket.com', 'your-domain.com', 'afternic.com', 'hugedomains.com', 'sedo.com',
]);

// Also from live testing: Wix/Sentry-style tracking beacons use a 32-char hex
// string as the email's local part (e.g. "605a7baede844d278b89dc95ae0a9123@...") -
// no real contact email looks like this, so reject on shape rather than domain
// alone (new tracking subdomains would otherwise slip through).
const HEX_HASH_LOCAL_PART = /^[0-9a-f]{32}$/i;

// Cycle 165 live-testing finding: the email regex matches retina-image
// filenames like "Group-276@2x.png" (word@word.ext) as false positives.
// Reject matches whose apparent TLD is actually a file extension.
const ASSET_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff',
  'css', 'js', 'json', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'mp4', 'mp3', 'webm', 'avi', 'mov',
]);

function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/\s/g, '').replace(/^0/, '+254').replace(/^254/, '+254');
  if (!cleaned.startsWith('+')) {
    return '+254' + cleaned;
  }
  return cleaned;
}

function extractContacts(html: string): { emails: string[]; phones: string[] } {
  // Cycle 165 live-testing finding: most false positives (tracking-hash
  // "emails" like Sentry/wixpress, and fabricated-looking phone numbers with
  // no relation to the page's real content) come from <script>/<style> blocks
  // - analytics IDs, chat-widget config, JS bundles. Strip them before matching.
  const cleanedHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // Extract emails
  const rawEmails = cleanedHtml.match(EMAIL_REGEX) || [];
  const emails = [...new Set(rawEmails)].filter(email => {
    const [localPart, domain] = email.split('@');
    // Regex false positive found live in Cycle 165 testing: retina image
    // filenames like "Group-276@2x.png" match the email pattern (word@word.ext).
    // Reject anything whose "TLD" is actually a common asset/file extension.
    const tld = domain?.split('.').pop()?.toLowerCase();
    const isAssetExtension = tld ? ASSET_EXTENSIONS.has(tld) : false;
    const isHexHash = HEX_HASH_LOCAL_PART.test(localPart);
    return domain && !FALSE_POSITIVE_DOMAINS.has(domain.toLowerCase()) && !isAssetExtension && !isHexHash && email.length < 100;
  });

  // Cycle 165B: phone extraction disabled per Kimi's brief. Cycle 165 proved
  // normalizePhone fabricates +254 numbers regardless of the site's real
  // country (identical fake value found on unrelated Kenyan and Swiss sites)
  // - not safe to ship without real validation, which is out of scope here.
  return { emails, phones: [] };
}

// POST /api/crm/scrape-contacts — batch website scraper
router.post('/scrape-contacts', adminAuth, async (req, res) => {
  try {
    const { batch_size = 20, delay_ms = 2000, run_by } = req.body;

    // Fetch batch of contacts with websites but no email/phone, excluding
    // ones already attempted (Cycle 165 live-testing found "no contacts
    // found" and http-error outcomes left nothing marking the attempt, so
    // unfiltered batches kept re-fetching the same non-yielding sites
    // instead of making forward progress - scrape_attempted_at fixes that).
    const { data: contacts, error: fetchError } = await supabase
      .from('crm_contacts')
      .select('id, name, website, entity_type')
      .not('website', 'is', null)
      .is('email', null)
      .is('phone', null)
      .is('scrape_attempted_at', null)
      .limit(batch_size);

    if (fetchError) throw fetchError;
    if (!contacts || contacts.length === 0) {
      return res.json({
        message: 'No contacts left to scrape',
        processed: 0,
        enriched: 0,
        errors: 0
      });
    }

    const results = [];
    let enrichedCount = 0;
    let errorCount = 0;

    for (const contact of contacts) {
      if (!contact.website) continue;

      // Ensure URL has protocol
      let url = contact.website.trim();
      if (!url.startsWith('http')) {
        url = 'https://' + url;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'ElimuX-Contact-Research/1.0 (Education Partnership Outreach)',
            'Accept': 'text/html',
          },
          signal: controller.signal,
          redirect: 'follow',
        });

        clearTimeout(timeout);

        if (!response.ok) {
          await supabase.from('crm_contacts').update({ scrape_attempted_at: new Date().toISOString() }).eq('id', contact.id);
          results.push({
            id: contact.id,
            name: contact.name,
            status: 'http_error',
            code: response.status
          });
          errorCount++;
          continue;
        }

        const html = await response.text();
        const { emails } = extractContacts(html);

        const updates: Record<string, any> = {
          scrape_attempted_at: new Date().toISOString(),
          enriched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (emails.length > 0) updates.email = emails[0]; // Take first found email
        // Phone extraction disabled in Cycle 165B - see extractContacts comment.

        if (emails.length > 0) {
          const { error: updateError } = await supabase
            .from('crm_contacts')
            .update(updates)
            .eq('id', contact.id);

          if (updateError) throw updateError;

          await supabase.from('crm_activities').insert({
            user_id: run_by || null,
            action: 'contact_scraped',
            entity_type: 'contact',
            entity_id: contact.id,
            metadata: {
              website: url,
              emails_found: emails.length,
              email_used: emails[0] || null,
            },
          });

          enrichedCount++;
          results.push({
            id: contact.id,
            name: contact.name,
            status: 'enriched',
            email: emails[0] || null,
          });
        } else {
          await supabase
            .from('crm_contacts')
            .update({ scrape_attempted_at: new Date().toISOString() })
            .eq('id', contact.id);
          results.push({
            id: contact.id,
            name: contact.name,
            status: 'no_contacts_found',
          });
        }

        // Delay between requests
        if (delay_ms > 0) {
          await new Promise(resolve => setTimeout(resolve, delay_ms));
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        results.push({
          id: contact.id,
          name: contact.name,
          status: 'error',
          error: errorMsg,
        });
        errorCount++;

        await supabase.from('crm_contacts').update({ scrape_attempted_at: new Date().toISOString() }).eq('id', contact.id);

        // Log failure
        await supabase.from('crm_activities').insert({
          user_id: run_by || null,
          action: 'contact_scrape_failed',
          entity_type: 'contact',
          entity_id: contact.id,
          metadata: { website: url, error: errorMsg },
        });
      }
    }

    res.json({
      processed: contacts.length,
      enriched: enrichedCount,
      errors: errorCount,
      remaining: (await supabase
        .from('crm_contacts')
        .select('*', { count: 'exact', head: true })
        .not('website', 'is', null)
        .is('email', null)
        .is('phone', null)
        .is('scrape_attempted_at', null)
      ).count || 0,
      results,
    });

  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
