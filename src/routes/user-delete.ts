import { Router } from 'express';
import { requireUser, UserAuthRequest } from '../middleware/user-auth';
import { supabase } from '../lib/supabase';

const router = Router();

router.delete('/delete-account', requireUser, async (req: UserAuthRequest, res) => {
  const userId = req.userId as string;
  const userEmail = req.userEmail;

  try {
    // sender_id is NOT NULL on this table, so it can't be nulled out - the
    // UUID is left in place but becomes unresolvable to any personal info
    // once the users row is deleted below (step 7).
    await supabase
      .from('scholarship_messages')
      .update({ sender_type: 'deleted_user' })
      .eq('sender_id', userId);

    // Anonymize reviews (user_id/reviewer_name/reviewer_email are all
    // nullable here, unlike scholarship_messages.sender_id) - keeps the
    // review content/rating public, matches the Background's stated intent
    // ("anonymizes user-generated content (reviews, messages)"), which the
    // original Task 1 code didn't actually implement for reviews.
    await supabase
      .from('reviews')
      .update({ user_id: null, reviewer_name: 'Deleted User', reviewer_email: null })
      .eq('user_id', userId);

    await supabase
      .from('scholarship_applications')
      .delete()
      .eq('student_id', userId);

    await supabase
      .from('scholarship_profiles')
      .delete()
      .eq('user_id', userId);

    await supabase
      .from('student_profiles')
      .delete()
      .eq('user_id', userId);

    // Paystack subscriber/subscriptions/payments are keyed by subscriber_id
    // (subscribers.id), a separate identity space from the auth user id -
    // subscribers has no user_id column, only email. Deleting the subscriber
    // row (found by the authenticated user's email) cascades to delete their
    // subscriptions and SETs NULL on payments.subscriber_id (both are live
    // FK delete rules on this schema), which detaches the financial records
    // from this user without erasing them outright.
    if (userEmail) {
      const { data: subscriber } = await supabase
        .from('subscribers')
        .select('id')
        .eq('email', userEmail)
        .maybeSingle();

      if (subscriber) {
        await supabase.from('subscribers').delete().eq('id', subscriber.id);
      }
    }

    // mpesa_transactions does not exist yet (Cycle 013's M-Pesa build is
    // still blocked) - add a delete step here once that table ships.

    await supabase
      .from('users')
      .delete()
      .eq('id', userId);

    const { error: authError } = await supabase.auth.admin.deleteUser(userId);
    if (authError) {
      console.error('Supabase auth deletion error:', authError);
    }

    return res.status(200).json({
      success: true,
      message: 'Account and personal data deleted. Some anonymized records may remain for legal/operational purposes.',
      deleted_at: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Account deletion error:', error);
    return res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
  }
});

export default router;
