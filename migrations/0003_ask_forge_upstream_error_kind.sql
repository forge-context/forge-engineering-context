-- Additive: classify upstream failures without storing any upstream detail.
-- Only a fixed safe category is ever written (network, timeout, authentication,
-- quota, api, malformed_model_json, internal). NULL for every other result_status
-- and for rows written before this migration.
ALTER TABLE audit_traces ADD COLUMN upstream_error_kind TEXT;
