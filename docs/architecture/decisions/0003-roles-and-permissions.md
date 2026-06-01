# ADR 0003: Scoped Roles and Centralized Permissions

## Status
Accepted

## Context
The early model put a single global `role` on `User` with the values
`admin | owner | operator | driver`. This conflated two different concepts:

- **platform authority** (is this person a platform admin?), and
- **per-entity authority** (is this person the owner or an operator of *this*
  parking lot?).

Because "owner"/"operator" were global, a user could not be the owner of one lot
and an operator of another, and the role said nothing about *which* entity it
applied to. There is no company grouping above the entity (see the
foundations + tabla-tasas integration): users relate directly to entities
(`tenants`) through `user_memberships`.

## Decision
Adopt the standard *scoped roles* pattern (as in GitHub orgs / cloud IAM):

1. **Global role** (`users.role`, enum `user_role`) collapses to `admin | user`.
   - `admin`: platform god-mode; sees and manages every entity.
   - `user`: everyone else. A `user` with no memberships is just an end user
     (e.g. a mobile-app driver).
2. **Per-entity role** lives on `user_memberships.role` (enum `membership_role`,
   `owner | operator`). A single `user` can be `owner` of one entity and
   `operator` of another.
3. **Centralized permissions** in `PermissionsService` (`src/auth/permissions.service.ts`)
   are the single source of the rules: `isAdmin`, `canViewEntity`,
   `canOperateEntity`, `canManageEntity`. Guards delegate to it:
   - `RolesGuard` enforces the global role for platform routes (`@Roles('admin')`).
   - `TenantMembershipGuard` resolves the membership, attaches it to the request,
     and enforces `@EntityRole(MembershipRole.owner)` on entity writes (admin
     bypasses). See ADR 0001.
4. **The JWT carries only `app_metadata.role`** (`admin | user`). The active
   entity and the per-entity role are **not** in the token; they are resolved
   per request (URL + membership) and exposed to clients via `GET /auth/me`.

Permission matrix:

| Action | admin | owner (membership) | operator (membership) | user w/o membership |
|---|---|---|---|---|
| Platform (review/approve applications) | ✓ | ✗ | ✗ | ✗ |
| View entity data | ✓ | ✓ | ✓ | ✗ |
| Operate (register entries/exits) | ✓ | ✓ | ✓ | ✗ |
| Manage entity (profile, rates, payment methods, zones) | ✓ | ✓ | ✗ | ✗ |

## Consequences

### Positive
- A user can hold different roles in different entities; "owner"/"operator" now
  mean what they say (scoped to an entity).
- One place (`PermissionsService`) to read, audit and extend the rules.
- **Offline-friendly** (desktop): switching the active entity does not re-mint a
  token (the entity is not in the JWT). The desktop caches `GET /auth/me`
  (role + memberships) and authorizes locally while offline; the server
  re-validates on sync (it remains the source of truth).

### Negative
- One extra DB lookup per entity request to load the membership (same trade-off
  as ADR 0001; mitigable with caching).
- Clients must call `GET /auth/me` to decide routing/portal, since the global
  role alone (`admin|user`) no longer distinguishes owner vs operator.
- Migrating data: the old global `owner/operator/driver` collapse to `user` and
  the per-entity role is backfilled into `user_memberships.role` (see migration
  `20260601212225_roles_v2.sql`).
