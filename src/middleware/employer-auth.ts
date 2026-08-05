// ============================================
// ELIMUX EMPLOYER PORTAL - AUTH MIDDLEWARE
// Mirrors institution-auth.ts / advertiser-auth.ts.
//
// The frontend has two co-existing ownership models that both shipped:
// register/vacancies/departments pages resolve the employer via a direct
// employers.user_id column, while team/settings pages resolve it via the
// employer_team_members join table (which supports multiple staff per
// employer with roles). Both are treated as valid here: a direct
// employers.user_id match is the legacy single-owner path and is granted
// 'super_admin' so it isn't locked out of anything a team-based super_admin
// could do.
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

export interface EmployerAuthRequest extends Request {
    userId?: string;
    employerId?: string;
    employerRole?: string;
    teamMemberId?: string;
}

const AUTH_TIMEOUT_MS = 8000; // 8 seconds max

export const employerAuth = async (req: EmployerAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ success: false, error: 'Unauthorized - No token provided' });
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
            res.status(401).json({ success: false, error: 'Unauthorized - Invalid token' });
            return;
        }

        req.userId = user.id;

        const { data: teamMember } = await supabaseAdmin
            .from('employer_team_members')
            .select('id, employer_id, role')
            .eq('user_id', user.id)
            .eq('is_active', true)
            .single();

        if (teamMember) {
            req.teamMemberId = teamMember.id;
            req.employerId = teamMember.employer_id;
            req.employerRole = teamMember.role;
            next();
            return;
        }

        const { data: ownedEmployer } = await supabaseAdmin
            .from('employers')
            .select('id')
            .eq('user_id', user.id)
            .single();

        if (ownedEmployer) {
            req.employerId = ownedEmployer.id;
            req.employerRole = 'super_admin';
            next();
            return;
        }

        res.status(403).json({ success: false, error: 'Forbidden - Not an employer account' });
    } catch (error: any) {
        console.error('Employer auth error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};

const MANAGE_ROLES = ['super_admin', 'admin'];

export const requireEmployerManage = (req: EmployerAuthRequest, res: Response, next: NextFunction): void => {
    if (!MANAGE_ROLES.includes(req.employerRole || '')) {
        res.status(403).json({ success: false, error: 'Forbidden - Requires admin or super_admin role' });
        return;
    }
    next();
};
