import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminMiddleware } from '../middleware/auth';

const router = Router();

// GET /api/institutions — list all (public)
// GET /api/institutions?featured=true — only currently-featured institutions,
// featured ones first (all rows match the filter, so this is really just
// "most-recently-featured first" via featured_until)
// GET /api/institutions?accreditation_body_id=... — only institutions accredited by that body
router.get('/', async (req, res) => {
  try {
    const { country_id, type_id, search, featured, accreditation_body_id, page = 1, limit = 20 } = req.query;

    let institutionIds: string[] | null = null;
    if (accreditation_body_id) {
      const { data: links, error: linksError } = await supabase
        .from('institution_accreditations')
        .select('institution_id')
        .eq('body_id', accreditation_body_id as string);

      if (linksError) {
        console.error('Error fetching accreditation links:', linksError);
        return res.status(500).json({ error: 'Failed to fetch institutions' });
      }

      institutionIds = Array.from(new Set((links || []).map((l) => l.institution_id)));
      if (institutionIds.length === 0) {
        return res.json({ data: [], meta: { page: Number(page), limit: Number(limit), total: 0, totalPages: 0 } });
      }
    }

    let query = supabase
      .from('institutions')
      .select(
        '*, type:institution_types(name, icon), country:countries(name, flag_emoji), accreditations:institution_accreditations(accreditation_status, body:accreditation_bodies(name, code, logo_url))',
        { count: 'exact' }
      );

    if (institutionIds) query = query.in('id', institutionIds);
    if (country_id) query = query.eq('country_id', country_id);
    if (type_id) query = query.eq('type_id', type_id);
    if (search) query = query.ilike('name', `%${search}%`);

    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    if (featured === 'true') {
      query = query
        .eq('is_featured', true)
        .gt('featured_until', new Date().toISOString())
        .order('featured_until', { ascending: false });
    } else {
      query = query.order('is_featured', { ascending: false }).order('name', { ascending: true });
    }

    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching institutions:', error);
      return res.status(500).json({ error: 'Failed to fetch institutions' });
    }

    return res.json({
      data: data || [],
      meta: { page: Number(page), limit: Number(limit), total: count || 0, totalPages: Math.ceil((count || 0) / Number(limit)) },
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/institutions/:id — single institution (public)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('institutions')
      .select('*, type:institution_types(*), country:countries(*), programs(*, category:program_categories(name, color))')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116' || error.code === '22P02') {
        return res.status(404).json({ error: 'Institution not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch institution' });
    }

    return res.json({ data });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/institutions/:id/accreditations — institution's accreditations (public)
router.get('/:id/accreditations', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('institution_accreditations')
      .select(
        'id, accreditation_number, accreditation_status, valid_from, valid_until, document_url, created_at, body:accreditation_bodies(id, name, code, logo_url, body_type)'
      )
      .eq('institution_id', id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching institution accreditations:', error);
      return res.status(500).json({ error: 'Failed to fetch accreditations' });
    }

    return res.json({ data: data || [] });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/institutions/apply — public: submit an institution application for review
router.post('/apply', async (req, res) => {
  try {
    const { name, type_id, country_id, city, website, email, phone, description } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Missing required fields', required: ['name', 'email'] });
    }

    const { data, error } = await supabase
      .from('institution_applications')
      .insert({
        name,
        type_id: type_id || null,
        country_id: country_id || null,
        city: city || null,
        website: website || null,
        email,
        phone: phone || null,
        description: description || null,
      })
      .select('id, access_token, status, submitted_at')
      .single();

    if (error) {
      console.error('Error creating institution application:', error);
      return res.status(500).json({ error: 'Failed to submit application', details: error.message });
    }

    return res.status(201).json({ data, message: 'Application submitted successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/institutions/apply/:token — public: check application status + its submitted programs
router.get('/apply/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const { data: application, error } = await supabase
      .from('institution_applications')
      .select('id, name, type_id, country_id, city, website, email, phone, description, status, admin_notes, submitted_at, reviewed_at')
      .eq('access_token', token)
      .single();

    if (error || !application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const { data: programs } = await supabase
      .from('program_applications')
      .select('id, name, level, duration_months, tuition_fees, currency, status, admin_notes, submitted_at')
      .eq('institution_application_id', application.id)
      .order('submitted_at', { ascending: true });

    return res.json({ data: { ...application, programs: programs || [] } });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/institutions — create (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { name, country_id, type_id, city, website_url, logo_url, cover_image_url, description, founded_year, student_count } = req.body;

    if (!name || !country_id || !type_id || !city) {
      return res.status(400).json({ error: 'Missing required fields', required: ['name', 'country_id', 'type_id', 'city'] });
    }

    const { data, error } = await supabase
      .from('institutions')
      .insert({
        name,
        country_id,
        type_id,
        city,
        website_url: website_url || null,
        logo_url: logo_url || null,
        cover_image_url: cover_image_url || null,
        description: description || null,
        founded_year: founded_year ? Number(founded_year) : null,
        student_count: student_count ? Number(student_count) : null,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating institution:', error);
      return res.status(500).json({ error: 'Failed to create institution', details: error.message });
    }

    return res.status(201).json({ data, message: 'Institution created successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/institutions/:id — update (admin only)
router.put('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('institutions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating institution:', error);
      return res.status(500).json({ error: 'Failed to update institution', details: error.message });
    }

    return res.json({ data, message: 'Institution updated successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/institutions/:id — delete (admin only)
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('institutions').delete().eq('id', id);

    if (error) {
      console.error('Error deleting institution:', error);
      return res.status(500).json({ error: 'Failed to delete institution', details: error.message });
    }

    return res.json({ message: 'Institution deleted successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
