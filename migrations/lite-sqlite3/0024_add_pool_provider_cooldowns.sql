-- The database mirror of the pool selector's provider cooldown state.
--
-- The selector's cooldown map is process-local (mirrored to Redis when
-- present), so a restart dropped every flag while the upstream kept refusing
-- the egress: dispatch re-picked a spent pool and the console showed nothing.
-- Dispatch-side flaggers write each marker into this column and boot reads it
-- back into the selector.
--
-- One entry per cooling provider, keyed by its lowercased id. `NULL` means no
-- provider was ever flagged; an entry whose `until` has passed is inert.
ALTER TABLE "network_pools"
  ADD COLUMN "provider_cooldowns" text;
