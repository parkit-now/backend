import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Service to manage the tenant context using AsyncLocalStorage.
 * This allows us to carry the tenantId throughout the request execution
 * without passing it as an argument to every function.
 */
@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<string>();

  /**
   * Runs a function within the context of a specific tenant.
   */
  runWithTenant<T>(tenantId: string, callback: () => T): T {
    return this.als.run(tenantId, callback);
  }

  /**
   * Gets the tenantId of the current execution context.
   * Returns undefined if called outside of a tenant context.
   */
  getTenantId(): string | undefined {
    return this.als.getStore();
  }

  /**
   * Gets the tenantId or throws an error if not found.
   */
  getTenantIdOrThrow(): string {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      throw new Error(
        '[TenantContextService] No tenantId found in current context. ' +
          'Ensure the TenantInterceptor is applied to the route.',
      );
    }
    return tenantId;
  }
}
