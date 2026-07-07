import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminMiddleware } from '../middleware/auth';

const router = Router();

// GET /api/institutions — list all (public)
router.get('/', async (req, res) => {
  try {
    const { country_id, type_id, search, page = 1, limit = 20 } = req.query;

    let query = supabase
      .from('institutions')
      .select('*, type:institution_types(name, icon), country:countries(name, flag_emoji)', { count: 'exact' });

    if (country_id) query = query.eq('country_id', country_id);
    if (type_id) query = query.eq('type_id', type_id);
    if (search) query = query.ilike('name', `%${search}%`);

    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    query = query.range(from, to).order('name', { ascending: true });

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
      if (error.code === 'PGRST116') {
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
