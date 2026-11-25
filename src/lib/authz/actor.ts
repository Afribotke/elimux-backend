// Actor resolution: who is the verified caller, in terms of the entities that
// own attachments? Every relationship comes from DB rows keyed by the
// verified user id (or, for admin_users, the verified email). Nothing here
// reads request bodies, query strings, headers, user_metadata or users.role.

export interface EmployerMembership {
  employerId: string
  /** 'owner' for employers.user_id; otherwise employer_team_members.role */
  role: string
}

export interface Actor {
  userId: string
  email: string | null
  employers: EmployerMembership[]
  /** institutions where the caller has an ACTIVE institution_accounts row */
  institutionIds: string[]
  /** admin_users / user_roles only (see middleware/auth.ts decideDbAdmin) */
  isPlatformAdmin: boolean
}

/** Data access needed to resolve an actor. Implementations must fail closed
 *  (throw) on query errors rather than returning partial data. */
export interface ActorSource {
  /** employers.id where employers.user_id = userId (0..n rows tolerated) */
  ownedEmployerIds(userId: string): Promise<string[]>
  /** active employer_team_members rows for userId (0..n rows tolerated) */
  activeTeamMemberships(userId: string): Promise<Array<{ employerId: string; role: string }>>
  /** institution_accounts.institution_id where user_id = userId AND status = 'active' */
  activeInstitutionIds(userId: string): Promise<string[]>
  /** DB-backed platform admin check */
  isPlatformAdmin(user: { id: string; email: string | null }): Promise<boolean>
}

export async function resolveActor(
  source: ActorSource,
  user: { id: string; email?: string | null }
): Promise<Actor> {
  const email = user.email ?? null
  const [owned, team, institutionIds, isPlatformAdmin] = await Promise.all([
    source.ownedEmployerIds(user.id),
    source.activeTeamMemberships(user.id),
    source.activeInstitutionIds(user.id),
    source.isPlatformAdmin({ id: user.id, email }),
  ])

  // Owner rows win over team rows for the same employer (owner ⊇ any team role).
  const byEmployer = new Map<string, EmployerMembership>()
  for (const m of team) byEmployer.set(m.employerId, { employerId: m.employerId, role: m.role })
  for (const id of owned) byEmployer.set(id, { employerId: id, role: 'owner' })

  return {
    userId: user.id,
    email,
    employers: [...byEmployer.values()],
    institutionIds: [...new Set(institutionIds)],
    isPlatformAdmin,
  }
}
