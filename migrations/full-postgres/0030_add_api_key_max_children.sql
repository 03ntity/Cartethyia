-- Add a share-template child slot cap.
--
-- Share enrollment links are public, and an attacker minting child rows is
-- only bounded by the per-IP dedupe, which IP rotation (CDN edges, cloud
-- egress, residential proxies) defeats. `max_children` lets an operator cap
-- how many concurrently-active child keys a template may mint; NULL keeps the
-- legacy unlimited behavior. Enforced at mint time (not a database
-- constraint) so the error path is a clean 429/409.

ALTER TABLE "api_keys" ADD COLUMN "max_children" integer;
