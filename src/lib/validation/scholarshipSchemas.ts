import { z } from 'zod';

// admin.ts's POST /scholarships and PATCH /scholarships/:id send datetime-local
// input values (e.g. "2026-08-16T14:30", no seconds, no Z/offset) straight
// through with no ISO conversion (verified against
// elimux-frontend/src/components/admin/AddScholarshipForm.tsx - all three
// date fields use <input type="datetime-local">). z.string().datetime()
// requires a full ISO 8601 string with a UTC/offset suffix and would reject
// every real submission from the actual admin form, so date fields use this
// looser "is this parseable as a date at all" check instead - still rejects
// garbage/injection strings, just not falsely strict about exact shape.
const dateTimeString = z.string().refine((val) => !isNaN(Date.parse(val)), {
  message: 'Invalid date/time value',
});

export const createScholarshipSchema = z.object({
  title: z.string().min(1).max(200),
  provider: z.string().min(1).max(200),
  provider_id: z.string().uuid().optional(),
  provider_logo_url: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  eligibility: z.string().max(2000).optional(),
  benefits: z.string().max(2000).optional(),
  amount: z.string().max(100).optional(),
  currency: z.string().max(3).default('KES'),
  coverage_type: z.string().max(50).optional(),
  institution_id: z.string().uuid().optional(),
  country_id: z.string().uuid().optional(),
  study_levels: z.array(z.string()).optional(),
  disciplines: z.array(z.string()).optional(),
  target_groups: z.array(z.string()).optional(),
  application_opens: dateTimeString.optional(),
  application_deadline: dateTimeString,
  notification_date: dateTimeString.optional(),
  application_url: z.string().url().max(500).optional(),
  application_process: z.string().max(2000).optional(),
  required_documents: z.array(z.string()).optional(),
  status: z.enum(['active', 'inactive', 'draft']).default('active'),
  is_featured: z.boolean().default(false),
  source_url: z.string().max(500).optional(),
  funding_amount: z.number().positive().optional(),
  duration: z.number().int().positive().optional(),
  duration_unit: z.enum(['days', 'weeks', 'months', 'years']).optional(),
  is_sponsored: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
  education_level: z.array(z.string()).optional(),
  field_of_study: z.array(z.string()).optional(),
  location_type: z.enum(['on-campus', 'online', 'hybrid']).optional(),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
});

export const updateScholarshipSchema = createScholarshipSchema.partial();

export type CreateScholarshipInput = z.infer<typeof createScholarshipSchema>;
export type UpdateScholarshipInput = z.infer<typeof updateScholarshipSchema>;
