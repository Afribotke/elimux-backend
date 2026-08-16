// ============================================
// ELIMUX INTERNSHIP / EMPLOYER MODULE
// Employer, student, public, and admin endpoints for the
// internship/attachment system. Application submission (with slot,
// eligibility and duplicate-prevention business rules) lives in
// ./applications.ts, mounted separately at /api/applications.
//
// Column names below were confirmed against the live production schema
// (Supabase REST introspection), not guessed from frontend code - the
// frontend has two divergent naming conventions for the `employers` table
// (register/vacancies pages vs settings page) and only one matches real
// columns. See employer-auth.ts for the two-model auth story.
// ============================================

import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { adminAuth } from '../middleware/auth';
import { requireUser, UserAuthRequest } from '../middleware/user-auth';
import { employerAuth, requireEmployerManage, EmployerAuthRequest } from '../middleware/employer-auth';

const router = Router();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'employer';
}

async function generateUniqueEmployerSlug(companyName: string): Promise<string> {
  const base = slugify(companyName);
  const { data: collisions } = await supabase
    .from('employers')
    .select('slug')
    .like('slug', `${base}%`);

  const taken = new Set((collisions || []).map((r: any) => r.slug));
  if (!taken.has(base)) return base;

  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ============================================
// EMPLOYER ENDPOINTS
// ============================================

// POST /employers/register — create employer profile for the logged-in user
router.post('/employers/register', requireUser, async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: existing } = await supabase
      .from('employers')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (existing) {
      res.status(409).json({ success: false, error: 'You already have an employer account' });
      return;
    }

    const b = req.body || {};
    // industry is NOT NULL on the live employers table - reject up front
    // with a clear message instead of letting a null through to a raw
    // Postgres constraint-violation error.
    if (!b.company_name || !b.company_email || !b.industry) {
      res.status(400).json({ success: false, error: 'company_name, company_email and industry are required' });
      return;
    }

    const slug = await generateUniqueEmployerSlug(b.company_name);

    const { data, error } = await supabase
      .from('employers')
      .insert({
        user_id: req.userId,
        company_name: b.company_name,
        company_email: b.company_email,
        company_phone: b.company_phone || null,
        registration_number: b.registration_number || null,
        kra_pin: b.kra_pin || null,
        industry: b.industry,
        company_size: b.company_size || null,
        website_url: b.website_url || null,
        description: b.description || null,
        location_county: b.location_county || null,
        location_address: b.location_address || null,
        slug,
        verification_status: 'pending',
        is_verified: false,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    console.error('Employer register error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /employers — list active, verified employers (any logged-in user, e.g.
// a university admin picking one when creating an attachment placement)
router.get('/employers', requireUser, async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('employers')
      .select('id, company_name, location_county, industry')
      .eq('is_active', true)
      .eq('verification_status', 'approved')
      .order('company_name', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /employers/me — own employer profile + role
router.get('/employers/me', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('employers')
      .select('*')
      .eq('id', req.employerId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Employer not found' });
      return;
    }

    res.json({ success: true, data: { ...data, role: req.employerRole } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const EDITABLE_EMPLOYER_FIELDS = [
  'company_name', 'company_email', 'company_phone', 'registration_number', 'kra_pin', 'tax_pin',
  'industry', 'company_size', 'website_url', 'logo_url', 'description', 'location_county',
  'location_address', 'nita_employer_number', 'year_established', 'county', 'town',
  'branding_primary_color', 'branding_logo_url', 'brand_colors',
];

// PATCH /employers/me — update own employer profile (admin/super_admin only)
router.patch('/employers/me', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const updates: Record<string, any> = {};
    for (const key of EDITABLE_EMPLOYER_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No editable fields provided', editable: EDITABLE_EMPLOYER_FIELDS });
      return;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('employers')
      .update(updates)
      .eq('id', req.employerId)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /employers/me/vacancies
router.get('/employers/me/vacancies', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('internships')
      .select('*, applications:applications(count)')
      .eq('employer_id', req.employerId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const EDITABLE_VACANCY_FIELDS = [
  'title', 'description', 'requirements', 'profession_category', 'course_tags', 'location_county',
  'is_remote', 'is_hybrid', 'duration_weeks', 'is_paid', 'stipend_amount_min', 'stipend_amount_max',
  'currency', 'min_year_of_study', 'application_deadline', 'start_date', 'end_date', 'status',
  'requires_cover_letter', 'requires_portfolio', 'requires_video_intro', 'application_form_questions',
  'nita_registered', 'nita_registration_number', 'target_audience', 'requires_university_verification',
  'partner_university_name', 'department_id', 'required_qualifications', 'requisition_id',
];

// POST /employers/me/vacancies — create internship (any active role except viewer)
router.post('/employers/me/vacancies', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    if (req.employerRole === 'viewer') {
      res.status(403).json({ success: false, error: 'Viewers cannot post vacancies' });
      return;
    }

    const b = req.body || {};
    if (!b.title || !b.description || !b.profession_category) {
      res.status(400).json({ success: false, error: 'title, description and profession_category are required' });
      return;
    }

    const totalSlots = Number(b.total_slots) > 0 ? Number(b.total_slots) : 1;
    const insertData: Record<string, any> = { employer_id: req.employerId, total_slots: totalSlots, remaining_slots: totalSlots, status: 'active' };
    for (const key of EDITABLE_VACANCY_FIELDS) {
      if (b[key] !== undefined) insertData[key] = b[key];
    }

    const { data, error } = await supabase
      .from('internships')
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    console.error('Create vacancy error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// PATCH /employers/me/vacancies/:id — update own internship (ownership checked)
router.patch('/employers/me/vacancies/:id', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    if (req.employerRole === 'viewer') {
      res.status(403).json({ success: false, error: 'Viewers cannot edit vacancies' });
      return;
    }

    const { data: existing } = await supabase
      .from('internships')
      .select('employer_id, total_slots, remaining_slots')
      .eq('id', req.params.id)
      .single();

    if (!existing) {
      res.status(404).json({ success: false, error: 'Vacancy not found' });
      return;
    }
    if (existing.employer_id !== req.employerId) {
      res.status(403).json({ success: false, error: 'Not your vacancy' });
      return;
    }

    const b = req.body || {};
    const updates: Record<string, any> = {};
    for (const key of EDITABLE_VACANCY_FIELDS) {
      if (b[key] !== undefined) updates[key] = b[key];
    }

    // Preserve slots already taken when total_slots changes without an
    // explicit remaining_slots — otherwise a resize could hand back slots
    // that were already given to accepted applicants.
    if (b.total_slots !== undefined && b.remaining_slots === undefined) {
      const takenSlots = existing.total_slots - existing.remaining_slots;
      const newTotal = Number(b.total_slots);
      updates.total_slots = newTotal;
      updates.remaining_slots = Math.max(0, newTotal - takenSlots);
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No editable fields provided' });
      return;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('internships')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE /employers/me/vacancies/:id — admin/super_admin only (destructive)
router.delete('/employers/me/vacancies/:id', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: existing } = await supabase
      .from('internships')
      .select('employer_id')
      .eq('id', req.params.id)
      .single();

    if (!existing) {
      res.status(404).json({ success: false, error: 'Vacancy not found' });
      return;
    }
    if (existing.employer_id !== req.employerId) {
      res.status(403).json({ success: false, error: 'Not your vacancy' });
      return;
    }

    const { error } = await supabase.from('internships').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, message: 'Vacancy deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /employers/me/applications — applications to any of the employer's internships
router.get('/employers/me/applications', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: internships } = await supabase
      .from('internships')
      .select('id, title')
      .eq('employer_id', req.employerId);

    const ids = (internships || []).map((i: any) => i.id);
    const titleById = new Map((internships || []).map((i: any) => [i.id, i.title]));

    if (ids.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('applications')
      .select('*, student:student_profiles(full_name, email, phone, university_name, course_name, year_of_study, skills, resume_url)')
      .in('internship_id', ids)
      .order('priority_score', { ascending: false })
      .order('submitted_at', { ascending: true });

    if (error) throw error;

    const withTitles = (data || []).map((a: any) => ({ ...a, internship_title: titleById.get(a.internship_id) }));
    res.json({ success: true, data: withTitles });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /employers/me/applications/:id/status — accept/reject (ownership checked)
router.patch('/employers/me/applications/:id/status', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    if (req.employerRole === 'viewer') {
      res.status(403).json({ success: false, error: 'Viewers cannot update applications' });
      return;
    }

    const allowedStatuses = ['reviewing', 'under_review', 'shortlisted', 'interview_scheduled', 'offered', 'accepted', 'rejected'];
    const { status, employer_notes, interview_date, interview_location, interview_link, offer_details } = req.body || {};

    if (!status || !allowedStatuses.includes(status)) {
      res.status(400).json({ success: false, error: 'Invalid status', allowed: allowedStatuses });
      return;
    }

    const { data: application } = await supabase
      .from('applications')
      .select('status, internship_id, internships:internship_id(employer_id)')
      .eq('id', req.params.id)
      .single();

    if (!application) {
      res.status(404).json({ success: false, error: 'Application not found' });
      return;
    }

    const owningEmployerId = (application as any).internships?.employer_id;
    if (owningEmployerId !== req.employerId) {
      res.status(403).json({ success: false, error: 'Not your application to manage' });
      return;
    }

    if (['accepted', 'rejected', 'withdrawn'].includes(application.status)) {
      res.status(400).json({ success: false, error: 'Cannot modify a finalized application' });
      return;
    }

    const updates: Record<string, any> = { status, updated_at: new Date().toISOString() };
    if (employer_notes !== undefined) updates.employer_notes = employer_notes;
    if (interview_date !== undefined) updates.interview_date = interview_date;
    if (interview_location !== undefined) updates.interview_location = interview_location;
    if (interview_link !== undefined) updates.interview_link = interview_link;
    if (offer_details !== undefined) updates.offer_details = offer_details;

    const { data, error } = await supabase
      .from('applications')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /employers/me/team
router.get('/employers/me/team', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('employer_team_members')
      .select('*, department:employer_departments(name)')
      .eq('employer_id', req.employerId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /employers/me/team — invite an existing user by their student/user id
router.post('/employers/me/team', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { user_id, role, department_id } = req.body || {};
    if (!user_id || !role) {
      res.status(400).json({ success: false, error: 'user_id and role are required' });
      return;
    }

    const validRoles = ['admin', 'manager', 'supervisor', 'viewer'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ success: false, error: 'Invalid role', allowed: validRoles });
      return;
    }

    const { data: existing } = await supabase
      .from('employer_team_members')
      .select('id')
      .eq('employer_id', req.employerId)
      .eq('user_id', user_id)
      .single();

    if (existing) {
      res.status(409).json({ success: false, error: 'This user is already on your team' });
      return;
    }

    const { data, error } = await supabase
      .from('employer_team_members')
      .insert({
        employer_id: req.employerId,
        user_id,
        role,
        department_id: department_id || null,
        invited_by: req.userId,
        is_active: true,
        invited_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE /employers/me/team/:id — remove a team member
router.delete('/employers/me/team/:id', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: existing } = await supabase
      .from('employer_team_members')
      .select('employer_id, role')
      .eq('id', req.params.id)
      .single();

    if (!existing) {
      res.status(404).json({ success: false, error: 'Team member not found' });
      return;
    }
    if (existing.employer_id !== req.employerId) {
      res.status(403).json({ success: false, error: 'Not your team member' });
      return;
    }
    if (existing.role === 'super_admin') {
      res.status(400).json({ success: false, error: 'Cannot remove the super admin' });
      return;
    }

    const { error } = await supabase.from('employer_team_members').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, message: 'Team member removed' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /employers/me/departments
router.get('/employers/me/departments', employerAuth, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('employer_departments')
      .select('*')
      .eq('employer_id', req.employerId)
      .order('name', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /employers/me/departments
router.post('/employers/me/departments', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description, head_name, head_email, head_phone, max_interns } = req.body || {};
    if (!name) {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }

    const { data, error } = await supabase
      .from('employer_departments')
      .insert({
        employer_id: req.employerId,
        name,
        description: description || null,
        head_name: head_name || null,
        head_email: head_email || null,
        head_phone: head_phone || null,
        max_interns: max_interns || 5,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE /employers/me/departments/:id
router.delete('/employers/me/departments/:id', employerAuth, requireEmployerManage, async (req: EmployerAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: existing } = await supabase
      .from('employer_departments')
      .select('employer_id')
      .eq('id', req.params.id)
      .single();

    if (!existing) {
      res.status(404).json({ success: false, error: 'Department not found' });
      return;
    }
    if (existing.employer_id !== req.employerId) {
      res.status(403).json({ success: false, error: 'Not your department' });
      return;
    }

    const { error } = await supabase.from('employer_departments').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true, message: 'Department removed' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// STUDENT ENDPOINTS
// ============================================

const EDITABLE_STUDENT_FIELDS = [
  'full_name', 'phone', 'course_name', 'course_category', 'year_of_study', 'preferred_locations',
  'preferred_industries', 'skills', 'portfolio_url', 'linkedin_url', 'github_url', 'resume_url',
  'is_open_to_remote', 'is_open_to_relocation', 'student_type', 'graduation_year', 'registration_number',
  'university_name',
];

// POST /students/profile — create/update own student profile
router.post('/students/profile', requireUser, async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const updates: Record<string, any> = { user_id: req.userId, updated_at: new Date().toISOString() };
    for (const key of EDITABLE_STUDENT_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.full_name === undefined) {
      // required by the table's NOT NULL-adjacent UI expectations; keep existing value on update
      delete updates.full_name;
    }
    if (req.body.email !== undefined) updates.email = req.body.email;
    else if (req.userEmail) updates.email = req.userEmail;

    const { data, error } = await supabase
      .from('student_profiles')
      .upsert(updates, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /students/me — own student profile
router.get('/students/me', requireUser, async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('student_profiles')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Student profile not found' });
      return;
    }

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /students/logbook — create a logbook entry for the caller's own profile
router.post('/students/logbook', requireUser, async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: profile } = await supabase
      .from('student_profiles')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!profile) {
      res.status(404).json({ success: false, error: 'Complete your student profile first' });
      return;
    }

    const b = req.body || {};
    if (!b.entry_date || !b.tasks_completed) {
      res.status(400).json({ success: false, error: 'entry_date and tasks_completed are required' });
      return;
    }

    const { data, error } = await supabase
      .from('logbook_entries')
      .insert({
        student_id: profile.id,
        internship_id: b.internship_id || null,
        entry_date: b.entry_date,
        week_number: b.week_number || null,
        tasks_completed: b.tasks_completed,
        skills_learned: b.skills_learned || null,
        challenges_faced: b.challenges_faced || null,
        supervisor_name: b.supervisor_name || null,
        hours_worked: b.hours_worked || null,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /students/me/logbook — own logbook entries
router.get('/students/me/logbook', requireUser, async (req: UserAuthRequest, res: Response): Promise<void> => {
  try {
    const { data: profile } = await supabase
      .from('student_profiles')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!profile) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('logbook_entries')
      .select('*')
      .eq('student_id', profile.id)
      .order('entry_date', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// PUBLIC ENDPOINTS
// ============================================

// GET /internships — list active internships with filters
router.get('/internships', async (req: Request, res: Response): Promise<void> => {
  try {
    const { profession_category, location_county, is_remote, target_audience, search, include_full } = req.query;

    let query = supabase
      .from('internships')
      .select('*, employer:employers(company_name, slug, logo_url, is_verified)')
      .eq('status', 'active');

    if (include_full !== 'true') query = query.gt('remaining_slots', 0);
    if (profession_category) query = query.eq('profession_category', profession_category as string);
    if (location_county) query = query.eq('location_county', location_county as string);
    if (is_remote === 'true') query = query.eq('is_remote', true);
    if (target_audience) query = query.eq('target_audience', target_audience as string);
    if (search) query = query.ilike('title', `%${search}%`);

    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /internships/:id — internship detail
router.get('/internships/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('internships')
      .select('*, employer:employers(company_name, slug, logo_url, is_verified, description, website_url)')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Internship not found' });
      return;
    }

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /employers/:slug — public employer profile for the careers page
router.get('/employers/:slug', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data: employer, error } = await supabase
      .from('employers')
      .select('id, company_name, slug, logo_url, description, website_url, industry, location_county, branding_primary_color, brand_colors, is_verified')
      .eq('slug', req.params.slug)
      .single();

    if (error || !employer) {
      res.status(404).json({ success: false, error: 'Employer not found' });
      return;
    }

    const { data: vacancies } = await supabase
      .from('internships')
      .select('id, title, profession_category, location_county, is_remote, duration_weeks, remaining_slots, application_deadline')
      .eq('employer_id', employer.id)
      .eq('status', 'active')
      .gt('remaining_slots', 0)
      .order('created_at', { ascending: false });

    res.json({ success: true, data: { ...employer, vacancies: vacancies || [] } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

router.get('/admin/internships', adminAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('internships')
      .select('*, employer:employers(company_name), applications:applications(count)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/admin/employers', adminAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('employers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/admin/students', adminAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('student_profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/admin/employers/:id/verify', adminAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      res.status(400).json({ success: false, error: 'Invalid status', allowed: ['approved', 'rejected', 'pending'] });
      return;
    }

    const { data, error } = await supabase
      .from('employers')
      .update({ verification_status: status, is_verified: status === 'approved', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
