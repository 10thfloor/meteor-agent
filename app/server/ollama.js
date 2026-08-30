export const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
export const OLLAMA_SHOW_URL = 'http://127.0.0.1:11434/api/show';
export const OLLAMA_OPENAI_URL = 'http://127.0.0.1:11434/v1';

const MAX_TAGS_BYTES = 1024 * 1024;
const MAX_MODELS = 64;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CLOUD_MODEL = /(?:-cloud|:cloud)(?::[^:]*)?$/i;

async function boundedJson(response) {
  if (!response?.ok) return null;
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TAGS_BYTES) return null;
  let text;
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let value = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > MAX_TAGS_BYTES) {
        await reader.cancel();
        return null;
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    text = value + decoder.decode();
  } else {
    text = await response.text();
    if (text.length > MAX_TAGS_BYTES) return null;
  }
  return JSON.parse(text);
}

/** Turn Ollama's local /api/tags response into bounded show candidates. */
export function parseOllamaTags(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.models)) return [];
  const seen = new Set();
  return payload.models.slice(0, MAX_MODELS * 2).flatMap((entry) => {
    const id = String(entry?.name ?? entry?.model ?? '').trim();
    if (!MODEL_NAME.test(id) || CLOUD_MODEL.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [{ id }];
  }).slice(0, MAX_MODELS);
}

function modelContext(payload) {
  const parameterText = typeof payload?.parameters === 'string' ? payload.parameters : '';
  const parameterMatch = parameterText.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/i);
  const parameterValue = Number(
    payload?.parameters && typeof payload.parameters === 'object'
      ? payload.parameters.num_ctx : parameterMatch?.[1],
  );
  const values = Object.entries(payload?.model_info ?? {})
    .filter(([key, value]) => key.endsWith('.context_length') && Number.isFinite(Number(value)))
    .map(([, value]) => Number(value))
    .filter((value) => value >= 2048 && value <= 2_000_000);
  const architectureMax = values.length > 0 ? Math.max(...values) : 32768;
  if (Number.isFinite(parameterValue) && parameterValue >= 2048 && parameterValue <= 2_000_000) {
    return { contextWindow: Math.min(parameterValue, architectureMax), verified: true };
  }
  // /api/show's model_info reports the architecture ceiling, not the active
  // allocation. Ollama can default as low as 4K depending on available VRAM,
  // so use that conservative floor until a Modelfile declares num_ctx.
  return { contextWindow: Math.min(4096, architectureMax), verified: false };
}

/** Only chat models with native tool calling can run the agent loop safely. */
export function ollamaModelFromShow(id, payload) {
  if (!MODEL_NAME.test(id) || CLOUD_MODEL.test(id) || !payload || typeof payload !== 'object') return null;
  const capabilities = new Set(
    Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((value) => typeof value === 'string') : [],
  );
  if (!capabilities.has('completion') || !capabilities.has('tools')) return null;
  const { contextWindow, verified: contextVerified } = modelContext(payload);
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: OLLAMA_OPENAI_URL,
    reasoning: capabilities.has('thinking'),
    input: capabilities.has('vision') ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(32768, Math.max(512, Math.floor(contextWindow / 4))),
    ...(!contextVerified
      ? { availabilityWarning: 'Active context was not reported; using a safe 4K limit. Configure Ollama num_ctx to at least 64K for agent work.' }
      : contextWindow < 65536
        ? { availabilityWarning: 'Context window is below the recommended 64K for agent work.' }
      : {}),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
      supportsReasoningEffort: false,
    },
  };
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

/** Probe only Ollama's fixed loopback URL. Failures are an ordinary "not
 * running" result. fetch injection keeps tests deterministic and offline. */
export async function detectOllamaModels({
  fetchImpl = globalThis.fetch,
  timeoutMs = 900,
  enabled = true,
} = {}) {
  if (!enabled || typeof fetchImpl !== 'function') return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(50, Math.min(timeoutMs, 2000)));
  try {
    const response = await fetchImpl(OLLAMA_TAGS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const candidates = parseOllamaTags(await boundedJson(response));
    const models = await mapConcurrent(candidates, 6, async ({ id }) => {
      try {
        const show = await fetchImpl(OLLAMA_SHOW_URL, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          // Model names stay in JSON; they are never appended to a URL.
          body: JSON.stringify({ model: id }),
        });
        return ollamaModelFromShow(id, await boundedJson(show));
      } catch {
        return null;
      }
    });
    return models.filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
