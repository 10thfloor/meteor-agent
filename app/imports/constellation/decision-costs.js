/** Public list pricing, not a provider invoice. Aliases intentionally have no
 * rate: only the resolved model returned with actual usage can be estimated. */
export const DECISION_COST_SOURCE = 'https://docs.typesafe.ai/models';
export const DECISION_COST_RATE_VERSION = 'typesafe-models:2026-09-21';
export const DECISION_MISSION_USAGE_COLLECTION = 'constellation_decision_mission_usage';

const rates = Object.freeze({
  'jev-1.13.0': Object.freeze({ inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 }),
});
const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0;
const validUsage = (usage) => usage && tokenCount(usage.input_tokens) && tokenCount(usage.output_tokens);

/** Snapshot the known public rate alongside the response's token usage. No
 * reservation, requested alias, or estimated token bound enters this amount. */
export function estimateDecisionCost({ model, usage } = {}) {
  if (!validUsage(usage)) return null;
  const rate = Object.hasOwn(rates, model) ? rates[model] : null;
  return {
    version: 1,
    kind: 'estimate',
    status: rate ? 'priced' : 'unpriced',
    currency: 'USD',
    model: typeof model === 'string' ? model : null,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    costUsd: rate ? (usage.input_tokens * rate.inputUsdPerMillion
      + usage.output_tokens * rate.outputUsdPerMillion) / 1_000_000 : null,
    inputUsdPerMillion: rate?.inputUsdPerMillion ?? null,
    outputUsdPerMillion: rate?.outputUsdPerMillion ?? null,
    rateVersion: rate ? DECISION_COST_RATE_VERSION : null,
    source: DECISION_COST_SOURCE,
  };
}

function storedEstimate(run) {
  const estimate = run.costEstimate;
  if (!estimate || estimate.version !== 1 || estimate.kind !== 'estimate'
    || estimate.currency !== 'USD' || estimate.model !== run.model
    || estimate.inputTokens !== run.usage.input_tokens
    || estimate.outputTokens !== run.usage.output_tokens) return null;
  if (estimate.status === 'unpriced' && estimate.costUsd === null) return estimate;
  if (estimate.status !== 'priced' || !Object.hasOwn(rates, estimate.model)
    || ![estimate.costUsd, estimate.inputUsdPerMillion, estimate.outputUsdPerMillion]
      .every((number) => typeof number === 'number' && Number.isFinite(number) && number >= 0)
    || typeof estimate.rateVersion !== 'string' || !estimate.rateVersion
    || typeof estimate.source !== 'string' || !estimate.source) return null;
  const expected = (estimate.inputTokens * estimate.inputUsdPerMillion
    + estimate.outputTokens * estimate.outputUsdPerMillion) / 1_000_000;
  return Math.abs(estimate.costUsd - expected) <= Number.EPSILON * Math.max(1, expected)
    ? estimate : null;
}

/** Sum all run receipts for one mission, including child sessions and failures
 * after a valid response. Amounts are partial when an outcome/rate is unknown.
 * Every run belongs to exactly one evaluation-status count. */
export function summarizeDecisionRuns(rows = []) {
  const summary = {
    costUsd: 0, inputTokens: 0, outputTokens: 0, evaluations: 0,
    pricedEvaluations: 0, pendingEvaluations: 0, unpricedEvaluations: 0,
    uncertainEvaluations: 0, notSentEvaluations: 0,
  };
  for (const run of rows) {
    summary.evaluations += 1;
    if (validUsage(run?.usage)) {
      summary.inputTokens += run.usage.input_tokens;
      summary.outputTokens += run.usage.output_tokens;
      const estimate = storedEstimate(run) ?? estimateDecisionCost(run);
      if (estimate.status === 'priced') {
        summary.costUsd += estimate.costUsd;
        summary.pricedEvaluations += 1;
      } else summary.unpricedEvaluations += 1;
    } else if (run?.status === 'running') summary.pendingEvaluations += 1;
    else if (run?.attempts === 0) summary.notSentEvaluations += 1;
    else summary.uncertainEvaluations += 1;
  }
  return summary;
}
