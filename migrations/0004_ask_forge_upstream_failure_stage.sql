-- Additive: make a malformed_model_json failure diagnosable without storing any
-- model output. Both columns hold a fixed safe category only.
--   upstream_failure_stage: upstream_json | upstream_shape | content_json | contract_validation
--   upstream_finish_reason: stop | length | content_filter | tool_calls | other
-- NULL for every other result_status and for rows written before this migration.
ALTER TABLE audit_traces ADD COLUMN upstream_failure_stage TEXT;

ALTER TABLE audit_traces ADD COLUMN upstream_finish_reason TEXT;
