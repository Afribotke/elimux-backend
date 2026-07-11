// One-off seed for gamification_badges, mirrors elimux-sql/10_gamification_badges_seed.sql.
// Run via `railway run -- npx ts-node scripts/seed-gamification-badges.ts` so it picks up
// the production SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY without those ever touching a
// local .env file.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '')

const badges = [
  { id: '7d1f0b3e-6a5b-4c1a-9d3e-1a2b3c4d5e01', name: 'First Steps', description: 'Earned your first point on ElimuX', icon: 'sparkles', criteria_type: 'points_total', criteria_threshold: 1, points_reward: 5, is_active: true },
  { id: '7d1f0b3e-6a5b-4c1a-9d3e-1a2b3c4d5e02', name: 'Explorer', description: 'Reached 25 points searching and browsing ElimuX', icon: 'search', criteria_type: 'points_total', criteria_threshold: 25, points_reward: 10, is_active: true },
  { id: '7d1f0b3e-6a5b-4c1a-9d3e-1a2b3c4d5e03', name: 'Reviewer', description: 'Reached 50 points - sharing your experience helps others choose', icon: 'star', criteria_type: 'points_total', criteria_threshold: 50, points_reward: 20, is_active: true },
  { id: '7d1f0b3e-6a5b-4c1a-9d3e-1a2b3c4d5e04', name: 'Super Sharer', description: 'Reached 100 points - a true ElimuX advocate', icon: 'share', criteria_type: 'points_total', criteria_threshold: 100, points_reward: 50, is_active: true },
  { id: '7d1f0b3e-6a5b-4c1a-9d3e-1a2b3c4d5e05', name: 'Community Champion', description: 'Reached 250 points - a pillar of the ElimuX community', icon: 'crown', criteria_type: 'points_total', criteria_threshold: 250, points_reward: 100, is_active: true },
  { id: '7d1f0b3e-6a5b-4c1a-9d3e-1a2b3c4d5e06', name: 'Referral Legend', description: 'Reached 500 points - among the most active ElimuX users', icon: 'trophy', criteria_type: 'points_total', criteria_threshold: 500, points_reward: 200, is_active: true },
]

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - run this via `railway run --`')
  }

  const { data, error } = await supabase.from('gamification_badges').upsert(badges, { onConflict: 'id' }).select()
  if (error) throw error

  console.log(`Seeded ${data?.length ?? 0} badges:`)
  for (const b of data || []) console.log(`  - ${b.name} (${b.criteria_threshold} pts)`)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
