import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase';
import { adminMiddleware } from '../middleware/auth';
import { requireUser, UserAuthRequest } from '../middleware/user-auth';

const router = Router();

// Helper: Calculate priority score
function calculatePriorityScore(studentType: string, source: string, isVerified: boolean): number {
  if (studentType === 'attachment' && source === 'university_upload') return 150;
  if (studentType === 'attachment' && isVerified) return 125;
  if (studentType === 'attachment') return 100;
  if (studentType === 'internship') return 50;
  return 0;
}

// POST /api/applications — Student applies to internship
//
// `applications.student_id` is a foreign key to `student_profiles.id`, NOT to
// the auth user id - inserting the caller's auth uid here (as this endpoint
// used to) violates that FK for every real user and fails silently from the
// frontend's point of view (a generic "Failed to submit" toast). The student
// profile row must be looked up first and its own id used everywhere.
router.post('/', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const schema = z.object({
      internship_id: z.string().uuid(),
      cover_letter: z.string().max(5000).optional(),
      portfolio_links: z.array(z.string().url()).optional(),
      video_intro_url: z.string().url().optional(),
      answers: z.record(z.string(), z.string()).optional(),
      enrollment_letter_url: z.string().url().optional(),
    });

    const body = schema.parse(req.body);

    // Fetch student profile to determine type, verification, and its own id
    const { data: student, error: studentError } = await supabase
      .from('student_profiles')
      .select('id, student_type, is_university_verified, university_name')
      .eq('user_id', req.userId)
      .single();

    if (studentError || !student) {
      return res.status(404).json({ success: false, error: 'Student profile not found. Please complete your profile first.' });
    }

    // Fetch internship to check target audience
    const { data: internship, error: internError } = await supabase
      .from('internships')
      .select('target_audience, requires_university_verification, remaining_slots, status')
      .eq('id', body.internship_id)
      .single();

    if (internError || !internship) {
      return res.status(404).json({ success: false, error: 'Internship not found' });
    }

    if (internship.status !== 'active') {
      return res.status(400).json({ success: false, error: 'This position is no longer accepting applications' });
    }

    if (internship.remaining_slots <= 0) {
      return res.status(400).json({ success: false, error: 'No remaining slots for this position' });
    }

    // Validate target audience
    if (internship.target_audience === 'attachment_only' && student.student_type !== 'attachment') {
      return res.status(403).json({ success: false, error: 'This position is only open to attachment students (currently enrolled)' });
    }

    if (internship.target_audience === 'internship_only' && student.student_type !== 'internship') {
      return res.status(403).json({ success: false, error: 'This position is only open to internship applicants (graduates)' });
    }

    // Validate university verification if required
    if (internship.requires_university_verification && !student.is_university_verified) {
      return res.status(403).json({
        success: false,
        error: 'This position requires university verification. Please ensure your institution has uploaded your details.'
      });
    }

    // Check for duplicate application
    const { data: existing } = await supabase
      .from('applications')
      .select('id')
      .eq('student_id', student.id)
      .eq('internship_id', body.internship_id)
      .single();

    if (existing) {
      return res.status(409).json({ success: false, error: 'You have already applied for this position' });
    }

    // Calculate priority score
    const priorityScore = calculatePriorityScore(
      student.student_type || 'internship',
      body.enrollment_letter_url ? 'university_upload' : 'self_applied',
      student.is_university_verified || false
    );

    // Claim a slot before inserting, with an optimistic-concurrency guard:
    // the conditional `eq('remaining_slots', ...)` only succeeds if no other
    // request has already claimed a slot since we read it above, closing the
    // race window a plain select-then-update would leave open.
    const { data: claimed, error: claimError } = await supabase
      .from('internships')
      .update({ remaining_slots: internship.remaining_slots - 1 })
      .eq('id', body.internship_id)
      .eq('remaining_slots', internship.remaining_slots)
      .select('id')
      .single();

    if (claimError || !claimed) {
      return res.status(409).json({ success: false, error: 'This position just filled up. Please try another listing.' });
    }

    // Create application
    const { data: application, error: insertError } = await supabase
      .from('applications')
      .insert({
        student_id: student.id,
        internship_id: body.internship_id,
        student_type: student.student_type,
        source: body.enrollment_letter_url ? 'university_upload' : 'self_applied',
        priority_score: priorityScore,
        university_name: student.university_name,
        enrollment_letter_url: body.enrollment_letter_url,
        cover_letter: body.cover_letter,
        portfolio_links: body.portfolio_links,
        video_intro_url: body.video_intro_url,
        answers: body.answers,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      // Insert failed after the slot was already claimed (e.g. a duplicate
      // slipped past the check above under concurrent requests) - give the
      // slot back rather than leaking it.
      await supabase
        .from('internships')
        .update({ remaining_slots: internship.remaining_slots })
        .eq('id', body.internship_id)
        .eq('remaining_slots', internship.remaining_slots - 1);
      throw insertError;
    }

    res.status(201).json({ success: true, data: application });

  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// GET /api/applications/me — the logged-in student's own applications
router.get('/me', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const { data: student } = await supabase
      .from('student_profiles')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!student) {
      return res.json({ success: true, data: [] });
    }

    const { data, error } = await supabase
      .from('applications')
      .select('*, internships:internship_id (title, employer_id, location_county, profession_category, status)')
      .eq('student_id', student.id)
      .order('submitted_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// GET /api/applications — Admin-only listing across all applications/employers.
// (Employer and student views should use /api/applications/me and
// /api/employers/me/applications, which are ownership-scoped.)
router.get('/', adminMiddleware, async (req, res) => {
  try {
    const { student_id, employer_id, internship_id, status } = req.query;
    let query = supabase.from('applications').select(`
      *,
      internships:internship_id (title, employer_id, location_county, profession_category)
    `);

    if (student_id) query = query.eq('student_id', student_id);
    if (internship_id) query = query.eq('internship_id', internship_id);
    if (status) query = query.eq('status', status);

    // If employer_id provided, filter by their internships
    if (employer_id) {
      const { data: employerInternships } = await supabase
        .from('internships')
        .select('id')
        .eq('employer_id', employer_id);

      const ids = (employerInternships || []).map(i => i.id);
      if (ids.length > 0) query = query.in('internship_id', ids);
    }

    const { data, error } = await query.order('priority_score', { ascending: false }).order('submitted_at', { ascending: true });
    if (error) throw error;

    res.json({ success: true, data: data || [] });

  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// GET /api/applications/:id — Single application detail, restricted to the
// owning student or an admin key.
// (Employers reach the same data ownership-scoped via
// /api/employers/me/applications instead.)
router.get('/:id', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select(`
        *,
        internships:internship_id (*),
        student_profiles:student_id (user_id, full_name, email, phone, university_name, course_name, year_of_study, skills, resume_url)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Application not found' });

    const ownerUserId = (data as any).student_profiles?.user_id;
    if (ownerUserId !== req.userId) {
      return res.status(403).json({ success: false, error: 'Not your application' });
    }

    res.json({ success: true, data });

  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// DELETE /api/applications/:id — Student withdraws their own application
router.delete('/:id', requireUser, async (req: UserAuthRequest, res: Response) => {
  try {
    const { data: application } = await supabase
      .from('applications')
      .select('internship_id, status, student_profiles:student_id (user_id)')
      .eq('id', req.params.id)
      .single();

    if (!application) return res.status(404).json({ success: false, error: 'Application not found' });

    const ownerUserId = (application as any).student_profiles?.user_id;
    if (ownerUserId !== req.userId) {
      return res.status(403).json({ success: false, error: 'Not your application' });
    }

    if (['accepted', 'rejected'].includes(application.status)) {
      return res.status(400).json({ success: false, error: 'Cannot withdraw a finalized application' });
    }

    // Delete application
    await supabase.from('applications').delete().eq('id', req.params.id);

    // Restore slot
    const { data: internship } = await supabase
      .from('internships')
      .select('remaining_slots')
      .eq('id', application.internship_id)
      .single();

    if (internship) {
      await supabase
        .from('internships')
        .update({ remaining_slots: internship.remaining_slots + 1 })
        .eq('id', application.internship_id);
    }

    res.json({ success: true, message: 'Application withdrawn' });

  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
