/**
 * Shared context for the provider-account store modules. The catalog store
 * class owns the handle and optional collaborators; the account and
 * operations modules receive them as this context so each file stays a plain
 * function module instead of a second class.
 */
import type { CartethyiaDatabase } from "../../../persistence/db-handle";
import type { AccountInflightReading } from "./contracts";
import type { RedisClient } from "../../../persistence/redis";
import type * as schema from "../../../persistence/schema";

/** One open transaction handle, as `CartethyiaDatabase.transaction` passes it. */
export type DbTx = Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0];

/** Store handle or an open transaction — both can run selects. */
export type DbOrTx = CartethyiaDatabase | DbTx;

/** What the account-persistence functions need from the owning store. */
export interface StoreAccountContext {
  readonly db: CartethyiaDatabase;
  readonly readAccountInflight?:
    | ((
        providerId: string,
        tenantId: string,
      ) => Promise<readonly AccountInflightReading[]>)
    | undefined;
}

/** What the account health/bulk-action functions additionally need. */
export interface StoreOperationsContext extends StoreAccountContext {
  readonly redis: RedisClient | undefined;
  /**
   * `ownsAccount` is implemented in `store-accounts.ts` and injected so the
   * operations module never re-derives the ownership predicate.
   */
  readonly ownsAccount: (
    tenantId: string,
    providerId: string,
    accountId: string,
  ) => Promise<boolean>;
}

/** One `provider_accounts` row as Drizzle returns it. */
export type ProviderAccountRow = typeof schema.providerAccounts.$inferSelect;
