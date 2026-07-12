import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { getDeviceFingerprint } from '../lib/deviceFingerprint';

const router = Router();

// GET /api/scholarships — list active scholarships with filters (public)
router.get('/', async (req, res) => {
  try {
    const { country_id, study_level, discipline, deadline_after, keyword, limit = 20, offset = 0 } = req.query;

    let query = supabase
      .from('scholarships')
      .select('*, institution:institutions(name), country:countries(name)', { count: 'exact' })
      .eq('status', 'active');

    if (country_id) query = query.eq('country_id', country_id);
    if (study_level) query = query.contains('study_levels', [study_level]);
    if (discipline) query = query.contains('disciplines', [discipline]);
    if (deadline_after) query = query.gte('application_deadline', deadline_after);
    if (keyword) {
      // Strip characters with special meaning in PostgREST's or() filter DSL
      // (comma separates conditions, parens group them) so user input can't
      // inject extra filter clauses.
      const safeKeyword = String(keyword).replace(/[,()]/g, '').trim();
      if (safeKeyword) {
        query = query.or(`title.ilike.%${safeKeyword}%,provider.ilike.%${safeKeyword}%,description.ilike.%${safeKeyword}%`);
      }
    }

    const from = Number(offset);
    const to = from + Number(limit) - 1;

    query = query
      .order('is_featured', { ascending: false })
      .order('application_deadline', { ascending: true })
      .range(from, to);

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching scholarships:', error);
      return res.status(500).json({ error: 'Failed to fetch scholarships' });
    }

    return res.json({
      data: data || [],
      meta: { limit: Number(limit), offset: from, total: count || 0 },
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scholarships/featured — is_featured = true, active only (public)
router.get('/featured', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scholarships')
      .select('*, institution:institutions(name), country:countries(name)')
      .eq('status', 'active')
      .eq('is_featured', true)
      .order('application_deadline', { ascending: true });

    if (error) {
      console.error('Error fetching featured scholarships:', error);
      return res.status(500).json({ error: 'Failed to fetch featured scholarships' });
    }

    return res.json({ data: data || [] });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scholarships/favorites — device's saved scholarships (public)
// Declared ahead of GET /:id so "favorites" isn't captured as an :id param.
router.get('/favorites', async (req, res) => {
  try {
    const deviceId = getDeviceFingerprint(req);

    const { data, error } = await supabase
      .from('scholarship_favorites')
      .select('*, scholarship:scholarships(*, institution:institutions(name), country:countries(name))')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching scholarship favorites:', error);
      return res.status(500).json({ error: 'Failed to fetch favorites' });
    }

    return res.json({ data: data || [] });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scholarships/:id — full detail (public)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('scholarships')
      .select('*, institution:institutions(name, city, logo_url), country:countries(name, flag_emoji)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116' || error.code === '22P02') {
        return res.status(404).json({ error: 'Scholarship not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch scholarship' });
    }

    return res.json({ data });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/scholarships/:id/favorite — save to scholarship_favorites (public)
router.post('/:id/favorite', async (req, res) => {
  try {
    const { id } = req.params;
    const deviceId = getDeviceFingerprint(req);

    // No unique constraint on (device_id, scholarship_id), so check first
    // rather than insert-and-catch to avoid duplicate rows on retry.
    const { data: existing } = await supabase
      .from('scholarship_favorites')
      .select('*')
      .eq('device_id', deviceId)
      .eq('scholarship_id', id)
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ data: existing });
    }

    const { data, error } = await supabase
      .from('scholarship_favorites')
      .insert({ device_id: deviceId, scholarship_id: id })
      .select()
      .single();

    if (error) {
      if (error.code === '23503') {
        return res.status(404).json({ error: 'Scholarship not found' });
      }
      console.error('Error saving scholarship favorite:', error);
      return res.status(500).json({ error: 'Failed to save favorite' });
    }

    return res.status(201).json({ data });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/scholarships/:id/favorite — remove from scholarship_favorites (public)
router.delete('/:id/favorite', async (req, res) => {
  try {
    const { id } = req.params;
    const deviceId = getDeviceFingerprint(req);

    const { error } = await supabase
      .from('scholarship_favorites')
      .delete()
      .eq('device_id', deviceId)
      .eq('scholarship_id', id);

    if (error) {
      console.error('Error removing scholarship favorite:', error);
      return res.status(500).json({ error: 'Failed to remove favorite' });
    }

    return res.json({ message: 'Favorite removed' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/scholarships/alerts — create a deadline/keyword alert (public)
router.post('/alerts', async (req, res) => {
  try {
    const { email, keywords, country_id, study_level } = req.body;
    const deviceId = getDeviceFingerprint(req);

    const { data, error } = await supabase
      .from('scholarship_alerts')
      .insert({
        device_id: deviceId,
        email: email || null,
        keywords: keywords || null,
        country_id: country_id || null,
        study_level: study_level || null,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating scholarship alert:', error);
      return res.status(500).json({ error: 'Failed to create alert', details: error.message });
    }

    return res.status(201).json({ data, message: 'Alert created successfully' });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
