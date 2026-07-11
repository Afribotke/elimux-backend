import { supabase } from './supabase'

export const TRACKABLE_EVENT_TYPES = ['search', 'page_view', 'click', 'application', 'review', 'share', 'payment'] as const
export type TrackableEventType = (typeof TRACKABLE_EVENT_TYPES)[number]

// UTC calendar boundaries - "today" is midnight UTC today, "month" is the 1st of
// the current UTC month. "week" is a rolling 7 days rather than a calendar week,
// since ISO-week-vs-Sunday-week is more bikeshed than the metric needs.
export function periodStarts(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const week = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { today: today.toISOString(), week: week.toISOString(), month: month.toISOString() }
}

// Device identity is spread across every feature that predates a single
// "users" table (favorites, gamification, and now analytics_events all key
// off the same sha256(ip+ua) fingerprint from lib/deviceFingerprint.ts) -
// this is the union of everywhere a device_id shows up.
export async function getUniqueDeviceIds(): Promise<Set<string>> {
  const [{ data: favorites }, { data: points }, { data: events }] = await Promise.all([
    supabase.from('user_favorites').select('device_id'),
    supabase.from('gamification_points').select('device_id'),
    supabase.from('analytics_events').select('user_device_id'),
  ])

  const ids = new Set<string>()
  for (const row of favorites || []) if (row.device_id) ids.add(row.device_id)
  for (const row of points || []) if (row.device_id) ids.add(row.device_id)
  for (const row of events || []) if (row.user_device_id) ids.add(row.user_device_id)
  return ids
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10)
}
