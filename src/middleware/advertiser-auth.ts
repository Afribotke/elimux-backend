// ============================================
// ELIMUX AD PORTAL - ADVERTISER AUTH MIDDLEWARE
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

export interface AdvertiserAuthRequest extends Request {
    advertiserId?: string;
    userId?: string;
    isAdmin?: boolean;
}

const AUTH_TIMEOUT_MS = 8000; // 8 seconds max

export const advertiserAuth = async (req: AdvertiserAuthRequest, res: Response, next: NextFunction): Promise<void> => {
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
        req.isAdmin = user.user_metadata?.role === 'admin';

        if (req.isAdmin) {
            next();
            return;
        }

        const { data: advertiser, error: advertiserError } = await supabaseAdmin
            .from('advertisers')
            .select('id, status')
            .eq('user_id', user.id)
            .single();

        if (advertiserError || !advertiser) {
            res.status(403).json({ error: 'Forbidden - Not an advertiser' });
            return;
        }

        if (advertiser.status !== 'active') {
            res.status(403).json({ error: 'Forbidden - Advertiser not approved', status: advertiser.status });
            return;
        }

        req.advertiserId = advertiser.id;
        next();
    } catch (error: any) {
        console.error('Advertiser auth error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const optionalAuth = async (req: AdvertiserAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            // Same untimeouted-call risk as advertiserAuth above, but this
            // middleware treats any auth failure as "proceed unauthenticated" -
            // a timeout here should fall through to next() too, not hang.
            const { data: { user } } = await Promise.race([
                supabaseAdmin.auth.getUser(token),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Auth service timeout')), AUTH_TIMEOUT_MS)
                )
            ]) as any;
            if (user) {
                req.userId = user.id;
                req.isAdmin = user.user_metadata?.role === 'admin';

                const { data: advertiser } = await supabaseAdmin
                    .from('advertisers')
                    .select('id, status')
                    .eq('user_id', user.id)
                    .single();

                if (advertiser && advertiser.status === 'active') {
                    req.advertiserId = advertiser.id;
                }
            }
        }
        next();
    } catch {
        next();
    }
};
