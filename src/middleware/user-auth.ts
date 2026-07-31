// ============================================
// GENERIC SUPABASE JWT AUTH
// Verifies the bearer token and attaches the user id/email.
// Used by student + application endpoints where "is this a valid
// logged-in user" is the only check needed (ownership is enforced
// per-row inside each route, not by a role table).
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

export interface UserAuthRequest extends Request {
    userId?: string;
    userEmail?: string;
}

export const requireUser = async (req: UserAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ success: false, error: 'Unauthorized - No token provided' });
            return;
        }

        const token = authHeader.split(' ')[1];
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

        if (error || !user) {
            res.status(401).json({ success: false, error: 'Unauthorized - Invalid token' });
            return;
        }

        req.userId = user.id;
        req.userEmail = user.email ?? undefined;
        next();
    } catch (error: any) {
        console.error('User auth error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
};
