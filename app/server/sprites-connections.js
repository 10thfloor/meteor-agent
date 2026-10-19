import { createHash } from 'node:crypto';

const invalid = () => { throw new Error('Sprites connection permissions could not be verified.'); };
const text = (value, max = 240) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : invalid();
const strings = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) return invalid();
  return [...new Set(value.map((entry) => text(entry, 512)))].sort();
};

/** Read-only inventory. Approval is an admission check, not a provider firewall.
 * Never update shared organization policies on the user's behalf. */
export function normalizeSpritesConnections(data) {
  if (!data || !Array.isArray(data.connections) || data.connections.length > 500
    || data.next_cursor || data.has_more) return invalid();
  const seen = new Set();
  const connections = data.connections.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid();
    const id = text(row.id); const provider = text(row.provider, 100);
    if (!id || !provider || seen.has(id)) return invalid(); seen.add(id);
    const policy = row.access_policy ?? {};
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).some((key) => !['allow_all', 'name_prefix', 'sprite_labels', 'allowed_endpoints', 'blocked_endpoints'].includes(key))
      || (policy.allow_all != null && typeof policy.allow_all !== 'boolean')) return invalid();
    const normalized = { allowAll: policy.allow_all === true, namePrefix: text(policy.name_prefix ?? ''),
      labels: strings(policy.sprite_labels), allowedEndpoints: strings(policy.allowed_endpoints), blockedEndpoints: strings(policy.blocked_endpoints) };
    // Conservative over-approximation for our generated names. Do not exclude
    // label grants: an owner may relabel a retained Sprite in the provider UI.
    // A name-specific grant is shown before its exact Sprite is allocated.
    const prefixMatches = !normalized.namePrefix || 'constellation-'.startsWith(normalized.namePrefix) || normalized.namePrefix.startsWith('constellation-');
    const mayAccess = normalized.allowAll || ((!!normalized.namePrefix || normalized.labels.length > 0) && prefixMatches);
    return { id, provider, name: text(row.provider_account_name || row.display_name || provider),
      scopes: Array.isArray(row.scopes) ? strings(row.scopes).join(', ') : text(row.scopes ?? '', 4096), policy: normalized, mayAccess };
  }).filter((row) => row.mayAccess).map(({ mayAccess, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id));
  return { connections, fingerprint: createHash('sha256').update(JSON.stringify(connections)).digest('hex') };
}

export async function inspectSpritesConnections({ token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) return invalid();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000); timer.unref?.();
  try {
    const response = await fetchImpl('https://api.sprites.dev/v1/oauth/connections', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal,
    });
    if (!response.ok || Number(response.headers?.get('content-length')) > 256000) return invalid();
    const reader = response.body?.getReader(); if (!reader) return invalid();
    let size = 0; const chunks = [];
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 256000) { await reader.cancel(); return invalid(); } chunks.push(Buffer.from(value));
    }
    return normalizeSpritesConnections(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { return invalid(); } finally { clearTimeout(timer); }
}
