import { Router } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /api/accreditation-bodies — list active bodies (public)
// Filter by country_id, body_type
router.get('/', async (req, res) => {
  try {
    const { country_id, body_type } = req.query;

    let query = supabase
      .from('accreditation_bodies')
      .select('*, country:countries(name, flag_emoji)')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (country_id) query = query.eq('country_id', country_id);
    if (body_type) query = query.eq('body_type', body_type);

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching accreditation bodies:', error);
      return res.status(500).json({ error: 'Failed to fetch accreditation bodies' });
    }

    return res.json({ data: data || [] });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/accreditation-bodies/:id — body details + accredited institutions (public)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: body, error } = await supabase
      .from('accreditation_bodies')
      .select('*, country:countries(name, flag_emoji)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116' || error.code === '22P02') {
        return res.status(404).json({ error: 'Accreditation body not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch accreditation body' });
    }

    const { data: institutions, error: institutionsError } = await supabase
      .from('institution_accreditations')
      .select(
        'id, accreditation_number, accreditation_status, valid_from, valid_until, document_url, institution:institutions(id, name, slug, logo_url, city, type:institution_types(name))'
      )
      .eq('body_id', id)
      .order('created_at', { ascending: false });

    if (institutionsError) {
      console.error('Error fetching accredited institutions:', institutionsError);
      return res.status(500).json({ error: 'Failed to fetch accredited institutions' });
    }

    return res.json({ data: { ...body, institutions: institutions || [] } });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
