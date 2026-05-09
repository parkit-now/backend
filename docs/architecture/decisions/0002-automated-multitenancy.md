# ADR 0002: Automated Multi-tenancy Isolation

## Status
Proposed

## Context
In ADR 0001, we established the need for tenant-level authorization. However, the implementation required manually passing `tenantId` from controllers to services and manually scoping Prisma queries using `prismaForTenant`. This led to:
1.  **Boilerplate**: Repetitive code in every service method.
2.  **Risk of Human Error**: A developer might forget to pass the `tenantId` or call the scoping function, leading to cross-tenant data leakage (since the backend uses `service_role`).

## Decision
We will implement automated, transparent multi-tenancy isolation using `AsyncLocalStorage` (ALS).

The implementation consists of:
1.  **`TenantContextService`**: Wraps Node.js `AsyncLocalStorage` to carry the `tenantId` for the lifetime of an asynchronous execution thread (the request).
2.  **`TenantInterceptor`**: A NestJS Interceptor that extracts `tenantId` from request parameters and initializes the ALS context.
3.  **Scoped Prisma Client**: The `PrismaService` now includes a `tenant` getter that automatically retrieves the `tenantId` from the ALS context and returns a scoped Prisma client (using the extension from ADR 0001).

## Consequences

### Positive
- **Clean Code**: Services no longer need to accept `tenantId` as an argument for every method. They just use `this.prisma.tenant`.
- **Developer Experience**: It's harder to make mistakes. If a developer tries to access `this.prisma.tenant` outside of a tenant-scoped request, an error is thrown immediately.
- **Maintainability**: The isolation logic is centralized in the infrastructure layer.

### Negative
- **Magic**: The data flow is less explicit, which might be confusing for developers unfamiliar with ALS.
- **Testing**: Unit tests need to mock the `tenant` property or the ALS context.
- **Performance**: Negligible overhead from ALS and interceptors.
