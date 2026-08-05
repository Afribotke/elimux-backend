// ============================================
// ELIMUX INSTITUTION PORTAL - AUTH MIDDLEWARE
// Mirrors advertiser-auth.ts: Supabase JWT →
// institution_accounts row → status check.
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

export interface InstitutionAuthRequest extends Request {
    institutionAccountId?: string;
    institutionId?: string;
    userId?: string;
}

const AUTH_TIMEOUT_MS = 8000; // 8 seconds max

export const institutionAuth = async (req: InstitutionAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized - No token provided' });
            return;
        }

        const token = authHeader.split(' ')[1];

        // Without this race, a slow/hung Supabase auth API leaves the request
        // (and the frontend's awaiting fetch()) stuck forever with no response.
        let authResult;
        try {
            authResult = await Promise.race([
                supabaseAdmin.auth.getUser(token),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Auth service timeout')), AUTH_TIMEOUT_MS)
                )
            ]);
        } catch (raceErr: any) {
            if (raceErr?.message === 'Auth service timeout') {
                res.status(503).json({ error: 'Authentication service temporarily unavailable. Please try again.' });
                return;
            }
            throw raceErr;
        }

        const { data: { user }, error: authError } = authResult as any;

        if (authError || !user) {
            res.status(401).json({ error: 'Unauthorized - Invalid token' });
            return;
        }

        req.userId = user.id;

        const { data: account, error: accountError } = await supabaseAdmin
            .from('institution_accounts')
            .select('id, institution_id, status')
            .eq('user_id', user.id)
            .single();

        if (accountError || !account) {
            res.status(403).json({ error: 'Forbidden - Not an institution account' });
            return;
        }

        if (account.status !== 'active') {
            res.status(403).json({ error: 'Forbidden - Institution account not approved', status: account.status });
            return;
        }

        req.institutionAccountId = account.id;
        req.institutionId = account.institution_id;
        next();
    } catch (error: any) {
        console.error('Institution auth error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
