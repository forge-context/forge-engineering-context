CREATE TABLE IF NOT EXISTS daily_usage (
  usage_date TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_usage (
  client_hash TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  day_count INTEGER NOT NULL DEFAULT 0,
  hour_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_hash, usage_date)
);

CREATE TABLE IF NOT EXISTS audit_traces (
  request_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  requirement_id TEXT,
  question_hash TEXT,
  question_preview TEXT,
  question_type TEXT,
  route TEXT,
  primary_source TEXT,
  additional_source TEXT,
  additional_reason TEXT,
  model_sufficiency TEXT,
  final_sufficiency TEXT,
  guardrails_triggered TEXT NOT NULL DEFAULT '[]',
  validation_warnings TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  result_status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_traces_created_at
ON audit_traces(created_at);
