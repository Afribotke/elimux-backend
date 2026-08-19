import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

// POST /api/bursary/cron/check-alerts
// Protected by X-Cron-Secret header matching CRON_SECRET env var. Generates
// two kinds of bursary_notifications: 'deadline' (open funds with a deadline
// in the next 7 days, for everyone who bookmarked or applied to that fund)
// and 'new_match' (funds opened in the last 24h, for everyone whose
// bursary_alert_preferences.alert_types includes 'new_match'). Both are
// deduplicated so re-running this doesn't spam the same user twice.
router.post('/check-alerts', async (req: Request, res: Response) => {
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * DAY_MS);
    const oneDayAgo = new Date(now.getTime() - DAY_MS);
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();

    let deadlineNotified = 0;
    let newMatchNotified = 0;

    // --- 1. Deadline alerts ---
    const { data: openFunds, error: openFundsError } = await supabase
      .from('bursary_funds')
      .select('id, name, application_window')
      .eq('status', 'open');
    if (openFundsError) throw openFundsError;

    const deadlineFunds = (openFunds || []).filter((f: any) => {
      const deadline = f.application_window?.deadline;
      if (!deadline) return false;
      const deadlineDate = new Date(deadline);
      return deadlineDate > now && deadlineDate <= in7Days;
    });

    for (const fund of deadlineFunds) {
      const userIds = new Set<string>();

      const { data: bookmarks } = await supabase.from('bursary_bookmarks').select('user_id').eq('fund_id', fund.id);
      (bookmarks || []).forEach((b: any) => userIds.add(b.user_id));

      const { data: applications } = await supabase
        .from('bursary_applications')
        .select('applicant:bursary_applicants(user_id)')
        .eq('fund_id', fund.id);
      (applications || []).forEach((a: any) => {
        if (a.applicant?.user_id) userIds.add(a.applicant.user_id);
      });

      const deadlineLabel = new Date(fund.application_window.deadline).toLocaleDateString();

      for (const userId of userIds) {
        const { data: existing } = await supabase
          .from('bursary_notifications')
          .select('id')
          .eq('user_id', userId)
          .eq('fund_id', fund.id)
          .eq('type', 'deadline')
          .gt('created_at', sevenDaysAgo)
          .maybeSingle();
        if (existing) continue;

        const { error: insertError } = await supabase.from('bursary_notifications').insert({
          user_id: userId,
          type: 'deadline',
          title: 'Application deadline approaching',
          message: `The deadline for "${fund.name}" is on ${deadlineLabel}. Apply now!`,
          fund_id: fund.id,
          is_read: false,
        });
        if (!insertError) deadlineNotified++;
      }
    }

    // --- 2. New fund alerts ---
    const { data: newFunds, error: newFundsError } = await supabase
      .from('bursary_funds')
      .select('id, name')
      .eq('status', 'open')
      .gt('created_at', oneDayAgo.toISOString());
    if (newFundsError) throw newFundsError;

    if (newFunds && newFunds.length > 0) {
      const { data: prefUsers } = await supabase
        .from('bursary_alert_preferences')
        .select('user_id')
        .contains('alert_types', ['new_match']);
      const userIds = (prefUsers || []).map((p: any) => p.user_id as string);

      for (const fund of newFunds) {
        for (const userId of userIds) {
          const { data: existing } = await supabase
            .from('bursary_notifications')
            .select('id')
            .eq('user_id', userId)
            .eq('fund_id', fund.id)
            .eq('type', 'new_match')
            .maybeSingle();
          if (existing) continue;

          const { error: insertError } = await supabase.from('bursary_notifications').insert({
            user_id: userId,
            type: 'new_match',
            title: 'New bursary available',
            message: `"${fund.name}" is now open for applications. Check it out!`,
            fund_id: fund.id,
            is_read: false,
          });
          if (!insertError) newMatchNotified++;
        }
      }
    }

    return res.json({
      success: true,
      fundsWithUpcomingDeadlines: deadlineFunds.length,
      newFundsChecked: newFunds?.length || 0,
      deadlineNotified,
      newMatchNotified,
    });
  } catch (err: any) {
    console.error('[Bursary Cron] check-alerts error:', err);
    return res.status(500).json({ error: 'Failed to run alert check' });
  }
});

export default router;
