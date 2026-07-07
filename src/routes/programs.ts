import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { adminMiddleware } from '../middleware/auth';

const router = Router();

// GET /api/programs — list all (public)
router.get('/', async (req, res) => {
  try {
    const { institution_id, category_id, level, search, min_tuition, max_tuition, page = 1, limit = 20 } = req.query;

    let query = supabase
      .from('programs')
      .select('*, institution:institutions(name, city, country:countries(name)), category:program_categories(name, color)', { count: 'exact' });

    if (institution_id) query = query.eq('institution_id', institution_id);
    if (category_id) query = query.eq('category_id', category_id);
    if (level) query = query.eq('level', level);
    if (min_tuition) query = query.gte('tuition_fees', Number(min_tuition));
    if (max_tuition) query = query.lte('tuition_fees', Number(max_tuition));
    if (search) query = query.ilike('name', `%${search}%`);

    const from = (Number(page) - 1) * Number(limit);
    const to = from + Number(limit) - 1;

    query = query.range(from, to).order('name', { ascending: true });

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching programs:', error);
      return res.status(500).json({ error: 'Failed to fetch programs' });
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

// GET /api/programs/institution/:institutionId — programs by institution (public)
router.get('/institution/:institutionId', async (req, res) => {
  try {
    const { institutionId } = req.params;

    const { data, error } = await supabase
      .from('programs')
      .select('*, category:program_categories(name, color)')
      .eq('institution_id', institutionId)
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching programs by institution:', error);
      return res.status(500).json({ error: 'Failed to fetch programs' });
    }

    return res.json({ data: data || [] });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/programs — create (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { institution_id, category_id, name, description, duration_months, tuition_fees, currency, level, entry_requirements, application_deadline, intake_dates } = req.body;

    if (!institution_id || !category_id || !name || !duration_months || tuition_fees === undefined || !currency || !level) {
      return res.status(400).json({ error: 'Missing required fields', required: ['institution_id', 'category_id', 'name', 'duration_months', 'tuition_fees', 'currency', 'level'] });
    }

    const { data, error } = await supabase
      .from('programs')
      .insert({
        institution_id,
        category_id,
        name,
        description: description || null,
        duration_months: Number(duration_months),
        tuition_fees: Number(tuition_fees),
        currency,
        level,
        entry_requirements: entry_requirements || null,
        application_deadline: application_deadline || null,
        intake_dates: intake_dates || [],
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating program:', error);
      return res.status(500).json({ error: 'Failed to create program', details: error.message });
    }

    return res.status(201).json({ data, message: 'Program created successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/programs/:id — update (admin only)
router.put('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data, error } = await supabase
      .from('programs')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating program:', error);
      return res.status(500).json({ error: 'Failed to update program', details: error.message });
    }

    return res.json({ data, message: 'Program updated successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/programs/:id — delete (admin only)
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('programs').delete().eq('id', id);

    if (error) {
      console.error('Error deleting program:', error);
      return res.status(500).json({ error: 'Failed to delete program', details: error.message });
    }

    return res.json({ message: 'Program deleted successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
