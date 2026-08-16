ALTER TABLE audit_traces ADD COLUMN cache_status TEXT NOT NULL DEFAULT 'bypass';

ALTER TABLE audit_traces ADD COLUMN model_called INTEGER NOT NULL DEFAULT 0;
