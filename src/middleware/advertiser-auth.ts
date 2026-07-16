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

export const advertiserAuth = async (req: AdvertiserAuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized - No token provided' });
            return;
        }

        const token = authHeader.split(' ')[1];

        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

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

        if (advertiser.status !== 'approved') {
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
            const { data: { user } } = await supabaseAdmin.auth.getUser(token);
            if (user) {
                req.userId = user.id;
                req.isAdmin = user.user_metadata?.role === 'admin';

                const { data: advertiser } = await supabaseAdmin
                    .from('advertisers')
                    .select('id, status')
                    .eq('user_id', user.id)
                    .single();

                if (advertiser && advertiser.status === 'approved') {
                    req.advertiserId = advertiser.id;
                }
            }
        }
        next();
    } catch {
        next();
    }
};
