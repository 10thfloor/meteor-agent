export const LOCAL_MODEL = 'constellation/scripted';
export const MODEL_ID_MAX = 320;

const PROVIDER_PRIORITY = Object.freeze([
  'anthropic', 'openai', 'google', 'xai', 'groq', 'mistral', 'deepseek',
  'openrouter', 'amazon-bedrock', 'google-vertex',
]);

export const PREFERRED_PROVIDER_MODELS = Object.freeze({
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  google: 'gemini-2.5-flash',
  xai: 'grok-4.3',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-small-latest',
  deepseek: 'deepseek-v4-flash',
  openrouter: 'anthropic/claude-haiku-4.5',
  'amazon-bedrock': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'google-vertex': 'gemini-2.5-flash',
});

const clean = (value, fallback, max = 160) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, max);
};

function normalizedModel(model) {
  if (!model || typeof model !== 'object') return null;
  const provider = String(model.provider ?? '').trim();
  const id = String(model.id ?? '').trim();
  if (!provider || !id || provider.includes('/') || id.startsWith('/')
    || /[\u0000-\u001f\u007f]/.test(provider) || /[\u0000-\u001f\u007f]/.test(id)
    || provider.length > 80 || `${provider}/${id}`.length > MODEL_ID_MAX) return null;
  return {
    id: `${provider}/${id}`,
    modelId: id,
    provider,
    label: clean(model.name, id, 160),
    ...(Number.isFinite(Number(model.contextWindow))
      ? { contextWindow: Math.max(0, Math.round(Number(model.contextWindow))) } : {}),
    ...(model.availabilityWarning
      ? { warning: clean(model.availabilityWarning, '', 240) } : {}),
  };
}

function modelSort(left, right) {
  return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
    || left.id.localeCompare(right.id);
}

/** Build the only model metadata sent to a browser. Raw model objects and auth
 * results stay server-side; this projection contains labels and ids only. */
export function buildModelCatalog({
  availableModels = [], knownModels = [], providerLabels = {}, providerKinds = {},
  savedModels = [], offline = false,
} = {}) {
  const normalizedAvailable = availableModels.map(normalizedModel).filter(Boolean);
  const availableById = new Map(normalizedAvailable.map((entry) => [entry.id, entry]));
  const knownById = new Map(knownModels.map(normalizedModel).filter(Boolean).map((entry) => [entry.id, entry]));
  const local = { id: LOCAL_MODEL, modelId: 'scripted', provider: 'constellation', label: 'Scripted (local)' };

  if (offline) availableById.clear();
  let preferredId = offline ? null : PROVIDER_PRIORITY.map((provider) => {
    const modelId = PREFERRED_PROVIDER_MODELS[provider];
    return modelId ? `${provider}/${modelId}` : null;
  }).find((id) => id && availableById.has(id));
  // Never make an arbitrary catalog entry the paid workspace default. A
  // provider without an intentional, present preference remains selectable,
  // while `default` stays on the deterministic local model.
  if (availableById.size === 0 || !preferredId) {
    availableById.set(local.id, local);
    knownById.set(local.id, local);
  }

  const groups = new Map();
  for (const entry of availableById.values()) {
    if (!groups.has(entry.provider)) groups.set(entry.provider, []);
    groups.get(entry.provider).push({
      id: entry.id,
      label: entry.label,
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.warning ? { warning: entry.warning } : {}),
    });
  }
  const providers = [...groups.entries()].map(([id, models]) => ({
    id,
    label: clean(providerLabels[id], id === 'constellation' ? 'Local' : id, 100),
    kind: providerKinds[id] === 'local' || id === 'constellation' ? 'local' : 'cloud',
    models: models.sort(modelSort),
  })).sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));

  const defaultModel = preferredId ?? LOCAL_MODEL;

  const unavailableModels = [...new Set(savedModels)]
    .filter((id) => typeof id === 'string' && id !== 'default' && !availableById.has(id))
    .map((id) => {
      const known = knownById.get(id);
      const slash = id.indexOf('/');
      const providerId = known?.provider ?? (slash > 0 ? id.slice(0, slash) : 'unknown');
      const modelId = known?.modelId ?? (slash > 0 ? id.slice(slash + 1) : id);
      return {
        id: clean(id, 'Unavailable model', 320),
        label: known?.label ?? clean(modelId, 'Unavailable model', 160),
        providerId: clean(providerId, 'unknown', 80),
        providerLabel: clean(providerLabels[providerId], providerId, 100),
        reason: 'Provider credentials are not configured.',
      };
    }).sort(modelSort);

  return {
    mode: providers.every((provider) => provider.kind === 'local') ? 'local' : 'live',
    defaultModel,
    providers,
    unavailableModels,
  };
}

export function modelIdsFromCatalog(catalog) {
  return new Set((catalog?.providers ?? []).flatMap(
    (provider) => (provider.models ?? []).map((entry) => entry.id),
  ));
}

/** Existing unavailable selections remain storable so a missing key never
 * corrupts an agent edit. A user cannot newly select an unavailable model. */
export function assertCrewModelAvailable(currentModel, requestedModel, availableIds) {
  if (requestedModel === 'default' || requestedModel === currentModel || availableIds.has(requestedModel)) {
    return requestedModel;
  }
  const error = new Error('This model is not available with the configured provider credentials.');
  error.code = 'model-unavailable';
  throw error;
}

export function effectiveCrewModel(configuredModel, catalog) {
  if (configuredModel === 'default') return catalog.defaultModel;
  // Preserve an explicit unavailable id so runtime routing can fail closed.
  // Substituting the workspace default here could silently run a paid model.
  return configuredModel;
}
