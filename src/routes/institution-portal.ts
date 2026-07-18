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

export default router;
