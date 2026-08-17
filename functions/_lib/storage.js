export function createD1Store(db) {
  if (!db) throw new Error("D1 binding DB is required");

  return {
    async consumeClientRate({ clientHash, usageDate, hourBucket, hourlyLimit, dailyLimit, nowIso }) {
      const row = await db
        .prepare(
          `INSERT INTO client_usage (
             client_hash, usage_date, hour_bucket, day_count, hour_count, updated_at
           ) VALUES (?, ?, ?, 1, 1, ?)
           ON CONFLICT(client_hash, usage_date) DO UPDATE SET
             day_count = client_usage.day_count + 1,
             hour_count = CASE
               WHEN client_usage.hour_bucket = excluded.hour_bucket
               THEN client_usage.hour_count + 1 ELSE 1 END,
             hour_bucket = excluded.hour_bucket,
             updated_at = excluded.updated_at
           RETURNING day_count, hour_count`,
        )
        .bind(clientHash, usageDate, hourBucket, nowIso)
        .first();
      return {
        ok: Number(row?.hour_count) <= hourlyLimit && Number(row?.day_count) <= dailyLimit,
        hourCount: Number(row?.hour_count || 0),
        dayCount: Number(row?.day_count || 0),
      };
    },

    async reserveGlobalBudget({ usageDate, requestLimit, tokenLimit, tokenReservation, nowIso }) {
      const row = await db
        .prepare(
          `INSERT INTO daily_usage (
             usage_date, request_count, input_tokens, output_tokens,
             total_tokens, reserved_tokens, updated_at
           )
           SELECT ?, 1, 0, 0, 0, ?, ?
           WHERE 1 <= ? AND ? <= ?
           ON CONFLICT(usage_date) DO UPDATE SET
             request_count = daily_usage.request_count + 1,
             reserved_tokens = daily_usage.reserved_tokens + excluded.reserved_tokens,
             updated_at = excluded.updated_at
           WHERE daily_usage.request_count < ?
             AND daily_usage.total_tokens + daily_usage.reserved_tokens + ? <= ?
           RETURNING request_count, total_tokens, reserved_tokens`,
        )
        .bind(
          usageDate,
          tokenReservation,
          nowIso,
          requestLimit,
          tokenReservation,
          tokenLimit,
          requestLimit,
          tokenReservation,
          tokenLimit,
        )
        .first();
      if (row) return { ok: true };

      const current = await db
        .prepare(
          `SELECT request_count, total_tokens, reserved_tokens
           FROM daily_usage WHERE usage_date = ?`,
        )
        .bind(usageDate)
        .first();
      const requestExhausted = Number(current?.request_count || 0) >= requestLimit;
      return { ok: false, reason: requestExhausted ? "request" : "token" };
    },

    async reconcileGlobalBudget({ usageDate, tokenReservation, usage, nowIso }) {
      await db
        .prepare(
          `UPDATE daily_usage SET
             input_tokens = input_tokens + ?,
             output_tokens = output_tokens + ?,
             total_tokens = total_tokens + ?,
             reserved_tokens = MAX(0, reserved_tokens - ?),
             updated_at = ?
           WHERE usage_date = ?`,
        )
        .bind(
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          tokenReservation,
          nowIso,
          usageDate,
        )
        .run();
    },

    async writeAudit(trace) {
      await db
        .prepare(
          `INSERT INTO audit_traces (
             request_id, created_at, requirement_id, question_hash, question_preview,
             question_type, route, primary_source, additional_source, additional_reason,
             model_sufficiency, final_sufficiency, guardrails_triggered,
             validation_warnings, input_tokens, output_tokens, total_tokens,
             latency_ms, result_status, upstream_error_kind, upstream_failure_stage,
             upstream_finish_reason, cache_status, model_called
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          trace.requestId,
          trace.createdAt,
          trace.requirementId,
          trace.questionHash,
          trace.questionPreview,
          trace.questionType,
          trace.route,
          trace.primarySource,
          trace.additionalSource,
          trace.additionalReason,
          trace.modelSufficiency,
          trace.finalSufficiency,
          JSON.stringify(trace.guardrailsTriggered || []),
          JSON.stringify(trace.validationWarnings || []),
          trace.inputTokens || 0,
          trace.outputTokens || 0,
          trace.totalTokens || 0,
          trace.latencyMs || 0,
          trace.resultStatus,
          trace.upstreamErrorKind || null,
          trace.upstreamFailureStage || null,
          trace.upstreamFinishReason || null,
          trace.cacheStatus || "bypass",
          trace.modelCalled ? 1 : 0,
        )
        .run();
    },
  };
}
