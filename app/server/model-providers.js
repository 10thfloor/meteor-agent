const RADIUS_PROVIDER_ID = 'radius';

const boundedTimeout = (value) => Math.max(50, Math.min(3_000, Number(value) || 1_500));

/** Refresh Radius's dynamic catalog without widening the startup network
 * surface. Auth is checked first, only Radius is selected, and the whole
 * operation shares one short abort deadline. The return value intentionally
 * contains no auth result, provider error, URL, or credential metadata. */
export async function refreshRadiusModels({
  models,
  enabled = true,
  timeoutMs = 1_500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!enabled || !models) return { configured: false, attempted: false, refreshed: false };

  let provider;
  try {
    provider = models.getProvider?.(RADIUS_PROVIDER_ID);
  } catch {
    return { configured: false, attempted: false, refreshed: false };
  }
  if (!provider || typeof provider.refreshModels !== 'function') {
    return { configured: false, attempted: false, refreshed: false };
  }

  const controller = new AbortController();
  let timer;
  let deadlineExpired = false;
  let radiusConfigured = false;
  let refreshAttempted = false;
  const deadlineResult = {
    configured: false, attempted: false, refreshed: false, timedOut: true,
  };
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      deadlineExpired = true;
      controller.abort();
      resolve(deadlineResult);
    }, boundedTimeout(timeoutMs));
  });
  const operation = (async () => {
    const auth = await models.checkAuth(RADIUS_PROVIDER_ID, { signal: controller.signal });
    if (!auth || controller.signal.aborted) {
      return { configured: false, attempted: false, refreshed: false };
    }
    radiusConfigured = true;
    refreshAttempted = true;
    const result = await models.refresh({
      providers: [RADIUS_PROVIDER_ID],
      allowNetwork: true,
      force: false,
      signal: controller.signal,
    });
    if (deadlineExpired) return deadlineResult;
    const failed = result?.aborted === true || result?.errors?.has?.(RADIUS_PROVIDER_ID) === true;
    return { configured: true, attempted: true, refreshed: !failed };
  })().catch(() => (deadlineExpired ? deadlineResult : {
    configured: radiusConfigured, attempted: refreshAttempted, refreshed: false,
  }));

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimer(timer);
    controller.abort();
  }
}
