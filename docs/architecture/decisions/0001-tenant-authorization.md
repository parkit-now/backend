# ADR 0001: Implementing Application-Level Tenant Authorization

## Status
Proposed

## Context
The system implements multi-tenancy where a `User` can be a member of multiple `Tenants` (parking lots) through the `UserMembership` table. 

While the database uses Row-Level Security (RLS) for client-side access, the NestJS backend uses the Prisma `service_role` connection, which bypasses RLS. To prevent data leakage between tenants (IDOR vulnerabilities), we use a Prisma extension that scopes queries by `tenantId`. However, there is currently no validation to ensure that the authenticated user actually has permission (membership) to access the specific `tenantId` requested in the URL.

## Decision
We will implement an application-level Authorization Guard (`TenantMembershipGuard`) in NestJS.

This guard will:
1. Extract the `userId` from the authenticated request (provided by `JwtAuthGuard`).
2. Extract the `tenantId` from the request parameters (URL).
3. Verify in the `UserMembership` table if a valid relationship exists between the user and the tenant.
4. Allow access if the relationship exists or if the user has a global `admin` role.
5. Deny access with a `403 Forbidden` response otherwise.

## Consequences

### Positive
- **Security**: Eliminates IDOR vulnerabilities where a user could access data from a different tenant by manipulating the URL.
- **Centralization**: Authorization logic is centralized in a Guard, keeping controllers and services clean.
- **Auditability**: It is easy to verify which endpoints are protected by checking the decorators.

### Negative
- **Performance**: Adds one additional database query per request to verify membership. (Note: This can be mitigated later with caching or by including membership info in the JWT if needed).
- **Complexity**: Developers must remember to apply the guard to new tenant-scoped controllers.
