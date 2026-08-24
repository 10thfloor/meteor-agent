import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { NAMES } from '../common/names';
import { MEMORY_SCOPES, type MemoryScope } from '../common/types';
import type { ResolvedMemory } from '../common/types';
import { forgetMemory, saveMemory, searchMemory } from './memory';

/**
 * The USER's memory surface: three DDP methods, so "what does this app
 * remember about me" is a subscription plus an edit button.
 *
 * NARROWER than the model's surface, deliberately (memory spec decision 7a).
 * Gates run at exactly one place in this package — the loop's dispatch path —
 * so a `gate: 'ask'` on the model's save does NOT protect this route. A client
 * calling `memory.save { scope: 'app' }` would otherwise write the shared work
 * pool that every session's system prompt reads, with no approval anywhere: a
 * prompt-injection primitive handed to any signed-in account. These bodies
 * therefore refuse app-scope writes and app-row deletes outright. Shared
 * knowledge is written by an approved model proposal, or server-side through
 * `Agent.memory`.
 */

/** Registration is LATCHED, not per-agent. `Meteor.methods` throws on a
 *  duplicate name and `defineAgent` is re-entrant — hot reload redefines every
 *  agent on every save, and a suite may define two memory agents in one
 *  process — so "register when an agent declares memory" must mean "once". */
let registered = false;

/** TEST SEAM, not public API: lets a suite assert the latch without a second
 *  process. Not re-exported from `server/index.ts`. */
export function _memoryMethodsRegistered(): boolean { return registered; }

/**
 * Which memory config governs a DDP call.
 *
 * The client names no agent, and it should not have to: person memory follows
 * the HUMAN, not the model (decision 2), so ANY memory-declaring agent's
 * config resolves the same person store. The first registered wins for caps;
 * the store it points at is identical either way.
 *
 * Installed by `registry` rather than imported FROM it: `registry` calls
 * `ensureMemoryMethods`, so importing the registry back here would close a
 * cycle. An injected resolver keeps this module a leaf.
 */
export type GoverningConfig = () => { config?: ResolvedMemory; agent: string };

let governingConfig: GoverningConfig = () => ({ agent: '' });

export function ensureMemoryMethods(resolve: GoverningConfig): void {
  governingConfig = resolve;
  if (registered) return;
  registered = true;

  Meteor.methods({
    async [NAMES.mMemorySave](args: unknown) {
      check(args, Match.Any);
      const a = (args ?? {}) as { text?: unknown; scope?: unknown; key?: unknown; pinned?: unknown };
      const userId = (this as Meteor.MethodThisType).userId ?? null;
      if (userId === null) {
        throw new Meteor.Error('not-authorized', 'Sign in to save a memory.');
      }
      const scope = (a.scope ?? 'user') as MemoryScope;
      if (!MEMORY_SCOPES.includes(scope)) {
        throw new Meteor.Error('invalid-args', `Unknown memory scope "${String(a.scope)}".`);
      }
      // Decision 7a — the whole point of this module.
      if (scope === 'app') {
        throw new Meteor.Error(
          'denied-scope',
          'Shared work memory cannot be written from a client; it is proposed by an '
          + 'agent and approved by a person.',
        );
      }
      const { config, agent } = governingConfig();
      if (!config) throw new Meteor.Error('no-memory', 'No agent in this app declares memory.');
      const result = await saveMemory(
        {
          text: String(a.text ?? ''),
          scope,
          ...(typeof a.key === 'string' ? { key: a.key } : {}),
          ...(a.pinned === true ? { pinned: true } : {}),
        },
        { by: `h:${userId}`, userId, agent, config },
      );
      // The core answers the MODEL in structured results (a refusal it can
      // route around); a DDP caller gets the same information as an error,
      // which is what a client's try/catch expects.
      if (!result.ok) throw new Meteor.Error(result.error, result.reason);
      return result;
    },

    async [NAMES.mMemorySearch](args: unknown) {
      check(args, Match.Any);
      const a = (args ?? {}) as { query?: unknown; limit?: unknown };
      const userId = (this as Meteor.MethodThisType).userId ?? null;
      if (userId === null) {
        throw new Meteor.Error('not-authorized', 'Sign in to search your memory.');
      }
      const { config, agent } = governingConfig();
      if (!config) throw new Meteor.Error('no-memory', 'No agent in this app declares memory.');
      return searchMemory(String(a.query ?? ''), {
        userId,
        agent,
        config,
        ...(typeof a.limit === 'number' ? { limit: a.limit } : {}),
      });
    },

    async [NAMES.mMemoryForget](args: unknown) {
      check(args, Match.Any);
      const a = (args ?? {}) as { id?: unknown };
      const userId = (this as Meteor.MethodThisType).userId ?? null;
      if (userId === null) {
        throw new Meteor.Error('not-authorized', 'Sign in to forget a memory.');
      }
      const { agent } = governingConfig();
      const result = await forgetMemory(String(a.id ?? ''), {
        userId,
        agent,
        // Decision 7a: never from a client.
        allowApp: false,
      });
      if (!result.ok) throw new Meteor.Error(result.error, result.reason);
      return result;
    },
  });
}
