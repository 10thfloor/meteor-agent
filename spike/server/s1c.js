// S1c — reach Node's OWN resolver from inside Meteor's CJS server bundle.
// Node 24 supports require() of ESM, and Node's resolver understands exports
// maps (which is what Meteor's does not). Three escalating strategies.
import path from 'path';
import fs from 'fs';

function findAppRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'node_modules', '@earendil-works', 'pi-ai'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function s1cReport() {
  const detail = { nodeVersion: process.version };
  const appRoot = findAppRoot();
  detail.appRoot = appRoot;

  // Step 1: can we get at Node's real `module` builtin from Meteor app code?
  let createRequire;
  try {
    ({ createRequire } = require('module'));
    detail.gotCreateRequire = typeof createRequire === 'function';
  } catch (e) {
    detail.gotCreateRequire = false;
    detail.createRequireError = e.message.split('\n')[0];
    return { ok: false, detail };
  }

  const nodeRequire = createRequire(path.join(appRoot, 'package.json'));

  // Strategy A: require() the ESM package directly (Node >= 22.12 feature).
  try {
    const m = nodeRequire('@earendil-works/pi-ai');
    detail.requireEsm = {
      ok: true,
      exports: Object.keys(m).length,
      hasCalculateCost: typeof m.calculateCost === 'function',
    };
  } catch (e) {
    detail.requireEsm = { ok: false, error: e.message.split('\n')[0], code: e.code };
  }

  // Strategy B: an .mjs shim parked in node_modules (never bundled by Meteor).
  // A real ESM module HAS a dynamic-import callback, so its import() works.
  try {
    const shimDir = path.join(appRoot, 'node_modules', '.agent-loader');
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'loader.mjs');
    fs.writeFileSync(shimPath, 'export const load = (s) => import(s);\n');
    const shim = nodeRequire(shimPath);
    const m = await shim.load('@earendil-works/pi-ai');
    detail.mjsShim = {
      ok: true,
      exports: Object.keys(m).length,
      hasCalculateCost: typeof m.calculateCost === 'function',
    };

    // Subpath through the same shim.
    const p = await shim.load('@earendil-works/pi-ai/providers/anthropic');
    detail.shimSubpath = { ok: true, exports: Object.keys(p).join(', ') };

    // typebox is the transitive ESM dep that Meteor's own resolver could NOT
    // find, and it is what the design uses for tool schemas. Build a real
    // schema through pi-ai's re-export to prove the whole graph is live.
    try {
      const schema = m.Type.Object({
        orderId: m.Type.String({ description: 'Order to look up' }),
        limit: m.Type.Optional(m.Type.Number()),
      });
      detail.typebox = {
        ok: true,
        schemaType: schema.type,
        properties: Object.keys(schema.properties),
        required: schema.required,
        jsonSchemaUsable: schema.type === 'object' && !!schema.properties.orderId,
      };
    } catch (e) {
      detail.typebox = { ok: false, error: e.message.split('\n')[0] };
    }
  } catch (e) {
    detail.mjsShim = { ok: false, error: e.message.split('\n')[0], code: e.code };
  }

  const ok = detail.requireEsm?.ok === true || detail.mjsShim?.ok === true;
  return { ok, detail };
}
