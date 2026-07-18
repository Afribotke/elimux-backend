// ============================================
// ELIMUX INSTITUTION PORTAL - ACCOUNT ROUTES
// Mounted at /api/institution-portal
// ============================================

import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { institutionAuth, InstitutionAuthRequest } from '../middleware/institution-auth';

const router = express.Router();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// POST /api/institution-portal/register - Claim an institution (creates a pending account).
// The user signs up via Supabase Auth client-side, then calls this with their JWT.
router.post('/register', async (req: Request, res: Response): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            res.status(401).json({ error: 'Invalid token' });
            return;
        }

        const { institution_id, contact_name } = req.body;

        if (!institution_id) {
            res.status(400).json({ error: 'institution_id is required' });
            return;
        }

        const { data: institution } = await supabaseAdmin
            .from('institutions')
            .select('id, name')
            .eq('id', institution_id)
            .single();

        if (!institution) {
            res.status(404).json({ error: 'Institution not found' });
            return;
        }

        // One account per institution — a claimed institution can't be re-claimed.
        const { data: existingClaim } = await supabaseAdmin
            .from('institution_accounts')
            .select('id')
            .eq('institution_id', institution_id)
            .single();

        if (existingClaim) {
            res.status(409).json({ error: 'This institution has already been claimed' });
            return;
        }

        const { data: existingAccount } = await supabaseAdmin
            .from('institution_accounts')
            .select('id')
            .eq('user_id', user.id)
            .single();

        if (existingAccount) {
            res.status(409).json({ error: 'You already have an institution account' });
            return;
        }

        const { data: account, error: insertError } = await supabaseAdmin
            .from('institution_accounts')
            .insert({
                institution_id,
                user_id: user.id,
                contact_name: contact_name || null,
                email: user.email,
                status: 'pending'
            })
            .select()
            .single();

        if (insertError) {
            console.error('Insert error:', insertError);
            res.status(500).json({ error: 'Failed to create institution account', details: insertError.message });
            return;
        }

        res.status(201).json({
            success: true,
            message: `Claim for "${institution.name}" submitted. Pending admin approval.`,
            data: account
        });
    } catch (error: any) {
        console.error('Institution register error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/institution-portal/profile - Own account + institution data
router.get('/profile', institutionAuth, async (req: InstitutionAuthRequest, res: Response): Promise<void> => {
    try {
        const { data: account, error } = await supabaseAdmin
            .from('institution_accounts')
            .select('*, institution:institutions(*)')
            .eq('user_id', req.userId)
            .single();

        if (error || !account) {
            res.status(404).json({ error: 'Account not found' });
            return;
        }

        res.json({ success: true, data: account });
    } catch (error: any) {
        console.error('Institution profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/institution-portal/institution - Edit own institution profile.
// Strict whitelist: identity fields (name, type, country) stay admin-controlled;
// institutions edit only their public-facing contact/presentation fields.
const EDITABLE_INSTITUTION_FIELDS = ['description', 'website_url', 'email', 'phone', 'logo_url', 'cover_image_url', 'city'];

router.put('/institution', institutionAuth, async (req: InstitutionAuthRequest, res: Response): Promise<void> => {
    try {
        const updates: Record<string, any> = {};
        for (const key of EDITABLE_INSTITUTION_FIELDS) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        if (Object.keys(updates).length === 0) {
            res.status(400).json({ error: 'No editable fields provided', editable: EDITABLE_INSTITUTION_FIELDS });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('institutions')
            .update(updates)
            .eq('id', req.institutionId)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to update institution', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Institution updated', data });
    } catch (error: any) {
        console.error('Institution edit error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/institution-portal/programs - List own programs
router.get('/programs', institutionAuth, async (req: InstitutionAuthRequest, res: Response): Promise<void> => {
    try {
        const { data, error } = await supabaseAdmin
            .from('programs')
            .select('*')
            .eq('institution_id', req.institutionId)
            .order('name', { ascending: true });

        if (error) {
            res.status(500).json({ error: 'Failed to fetch programs', details: error.message });
            return;
        }

        res.json({ success: true, data: data || [] });
    } catch (error: any) {
        console.error('List own programs error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/institution-portal/programs - Create a program under own institution
router.post('/programs', institutionAuth, async (req: InstitutionAuthRequest, res: Response): Promise<void> => {
    try {
        const { name, category_id, description, duration_months, tuition_fees, currency, level, requirements } = req.body;

        if (!name) {
            res.status(400).json({ error: 'name is required' });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('programs')
            .insert({
                institution_id: req.institutionId,
                name,
                category_id: category_id || null,
                description: description || null,
                duration_months: duration_months || null,
                tuition_fees: tuition_fees || null,
                currency: currency || 'KES',
                level: level || null,
                requirements: requirements || null,
                is_active: true
            })
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to create program', details: error.message });
            return;
        }

        res.status(201).json({ success: true, message: 'Program created', data });
    } catch (error: any) {
        console.error('Create own program error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/institution-portal/programs/:id - Update own program (ownership-checked)
const EDITABLE_PROGRAM_FIELDS = ['name', 'category_id', 'description', 'duration_months', 'tuition_fees', 'currency', 'level', 'requirements', 'is_active'];

router.put('/programs/:id', institutionAuth, async (req: InstitutionAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        const { data: existing } = await supabaseAdmin
            .from('programs')
            .select('institution_id')
            .eq('id', id)
            .single();

        if (!existing) {
            res.status(404).json({ error: 'Program not found' });
            return;
        }

        if (existing.institution_id !== req.institutionId) {
            res.status(403).json({ error: 'Access denied - not your program' });
            return;
        }

        const updates: Record<string, any> = {};
        for (const key of EDITABLE_PROGRAM_FIELDS) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        if (Object.keys(updates).length === 0) {
            res.status(400).json({ error: 'No editable fields provided', editable: EDITABLE_PROGRAM_FIELDS });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('programs')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to update program', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Program updated', data });
    } catch (error: any) {
        console.error('Update own program error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/institution-portal/programs/:id - Soft-delete own program (is_active = false)
router.delete('/programs/:id', institutionAuth, async (req: InstitutionAuthRequest, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        const { data: existing } = await supabaseAdmin
            .from('programs')
            .select('institution_id')
            .eq('id', id)
            .single();

        if (!existing) {
            res.status(404).json({ error: 'Program not found' });
            return;
        }

        if (existing.institution_id !== req.institutionId) {
            res.status(403).json({ error: 'Access denied - not your program' });
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('programs')
            .update({ is_active: false })
            .eq('id', id)
            .select()
            .single();

        if (error) {
            res.status(500).json({ error: 'Failed to delete program', details: error.message });
            return;
        }

        res.json({ success: true, message: 'Program removed', data });
    } catch (error: any) {
        console.error('Delete own program error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
