-- Adds the `random` pool-group selection strategy (per-tenant scatter across
-- eligible pools instead of the ordered least-loaded / round-robin scans).
ALTER TYPE pool_routing_strategy ADD VALUE IF NOT EXISTS 'random';
