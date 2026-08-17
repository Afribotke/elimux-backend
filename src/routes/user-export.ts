import { Router } from 'express';
import { requireUser, UserAuthRequest } from '../middleware/user-auth';
import { supabase } from '../lib/supabase';

const router = Router();

router.get('/export-data', requireUser, async (req: UserAuthRequest, res) => {
  const userId = req.userId as string;
  const userEmail = req.userEmail;

  try {
    const [
      { data: profile },
      { data: applications },
      { data: alerts },
      { data: messages },
      { data: scholarshipProfile },
      { data: studentProfile },
    ] = await Promise.all([
      supabase.from('users').select('*').eq('id', userId).single(),
      supabase.from('scholarship_applications').select('*').eq('student_id', userId),
      // scholarship_alerts has no user_id column, only device_id (a device
      // fingerprint, unrelated to auth identity) and email. Email is the only
      // field on this table that can be correlated to the authenticated user,
      // so this is a best-effort match, not a guaranteed-complete one.
      userEmail
        ? supabase.from('scholarship_alerts').select('*').eq('email', userEmail)
        : Promise.resolve({ data: [] as any[] }),
      // Includes messages the user received, not just sent - both are the
      // user's personal data under GDPR Article 15.
      supabase
        .from('scholarship_messages')
        .select('*')
        .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`),
      supabase.from('scholarship_profiles').select('*').eq('user_id', userId).single(),
      supabase.from('student_profiles').select('*').eq('user_id', userId).single(),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      data: {
        profile: profile || null,
        scholarship_applications: applications || [],
        // scholarship_favorites has no user_id or email column, only
        // device_id - there is currently no schema-level way to correlate a
        // favorite to an authenticated user, so it cannot be included here.
        scholarship_favorites: [] as any[],
        scholarship_alerts: alerts || [],
        scholarship_messages: messages || [],
        scholarship_profile: scholarshipProfile || null,
        student_profile: studentProfile || null,
      },
      notes: [
        'scholarship_favorites omitted: the table has no user_id or email column (device_id only), so favorites cannot currently be linked to an authenticated user.',
        'scholarship_alerts matched by email, not user_id (no such column exists on that table) - alerts created under a different email address will not appear.',
      ],
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="elimux-data-export-${userId}.json"`);
    return res.status(200).json(exportData);
  } catch (error) {
    console.error('Data export error:', error);
    return res.status(500).json({ error: 'Failed to export data' });
  }
});

export default router;
