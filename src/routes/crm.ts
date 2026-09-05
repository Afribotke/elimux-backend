import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { sendTemplatedEmail } from '../lib/email';
import { adminAuth } from '../middleware/auth';

const router = Router();

// GET /api/crm/contacts — list with filters
router.get('/contacts', adminAuth, async (req, res) => {
  try {
    const { entity_type, status, county, assigned_to, search, page = '1', limit = '50' } = req.query;

    let query = supabase
      .from('crm_contacts')
      .select('*', { count: 'exact' });

    if (entity_type) query = query.eq('entity_type', entity_type);
    if (status) query = query.eq('status', status);
    if (county) query = query.eq('county', county);
    if (assigned_to) query = query.eq('assigned_to', assigned_to);
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

// POST /api/crm/contacts/:id/people — add a contact person
router.post('/contacts/:id/people', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, title, email, phone, whatsapp, is_primary, is_decision_maker, notes } = req.body;

    const { data, error } = await supabase
      .from('crm_contact_people')
      .insert({
        contact_id: id,
        name,
        title,
        email,
        phone,
        whatsapp,
        is_primary: is_primary || false,
        is_decision_maker: is_decision_maker || false,
        notes,
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('crm_activities').insert({
      user_id: req.body.sent_by,
      action: 'contact_person_added',
      entity_type: 'contact',
      entity_id: id,
      metadata: { person_name: name, email, phone },
    });

    res.json(data);
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

export default router;
