import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage } from '../common/types';
import { runTurn } from './loop';
import { buildRunConfig, getAgent, type AgentConfig } from './registry';
import { eraseOwnedSession } from './session-lifecycle';
import { readTurnOutcome } from './subagent';
import { createInitialTranscript } from './transcript';

/** Evaluation runs are deliberately separate from Agent learning. They use the
 * configured model, instructions, skills and tool schemas, but no identity,
 * Fact Memory, Experience, Practice, approvals, or executable Tools. The model
 * can still propose a Tool call, which is enough to score tool selection
 * without letting a benchmark mutate the workspace or an external system. */

export const EVALUATION_TEXT_MAX = 50_000;
export const EVALUATION_ASSERTION_MAX = 20;
export const EVALUATION_SCORER_MAX = 12;
export const EVALUATION_SCORER_TIMEOUT_MS = 30_000;
export const EVALUATION_SCORER_TIMEOUT_MAX_MS = 60_000;

export interface EvaluationExpected {
  contains: string[];
  avoids: string[];
  requiredTool?: string;
}

/** Synthetic, immutable context for evaluating memory-shaped behavior without
 * reading or writing the live Agent's stores. These strings are ordinary test
 * prompt material; they do not claim to exercise retrieval ranking. */
export interface EvaluationFixtures {
  facts?: string[];
  experiences?: string[];
  practices?: string[];
  constitution?: string;
}

export interface EvaluationScenarioSnapshot {
  scenarioId: string;
  revision: number;
  name: string;
  prompt: string;
  expected: EvaluationExpected;
  scorerIds: string[];
  fixtures?: EvaluationFixtures;
}

export interface EvaluationAgentRun {
  output: string;
  /** Tool names only. Arguments and results may contain secrets and are not
   * evaluation evidence for the deterministic selection gate. */
  toolCalls: string[];
  durationMs: number;
  model?: string;
  agentVersion?: string;
  usage?: { input: number; output: number; cost: number };
  error?: { code: string; reason: string };
}

export interface EvaluationScore {
  id: string;
  kind: 'deterministic' | 'custom' | 'model';
  pass: boolean;
  /** Normalized 0..1 so custom and model judges can be compared. */
  score: number;
  reason: string;
}

export interface EvaluationScorerContext {
  userId: string;
  agentId: string;
  scenario: EvaluationScenarioSnapshot;
  run: Readonly<EvaluationAgentRun>;
  /** Hooks that perform I/O should stop promptly when the evaluation times out. */
  signal?: AbortSignal;
}

export interface EvaluationScorerDefinition {
  id: string;
  name: string;
  kind: 'custom' | 'model';
  timeoutMs?: number;
  evaluate(
    context: EvaluationScorerContext,
  ): Promise<Partial<Pick<EvaluationScore, 'pass' | 'score' | 'reason'>>>
    | Partial<Pick<EvaluationScore, 'pass' | 'score' | 'reason'>>;
}

export interface EvaluatedAgentRun extends EvaluationAgentRun {
  status: 'passed' | 'failed' | 'error';
  scores: EvaluationScore[];
}

function oneLine(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 240) : fallback;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function includes(output: string, expected: string): boolean {
  return normalizedText(output).includes(normalizedText(expected));
}

/** Pure, repeatable gates: every configured assertion must pass. An empty
 * assertion set is a passing baseline, not an invented model-quality score. */
export function scoreEvaluationDeterministically(
  expected: EvaluationExpected,
  run: Pick<EvaluationAgentRun, 'output' | 'toolCalls'>,
): EvaluationScore[] {
  const scores: EvaluationScore[] = [];
  for (let index = 0; index < expected.contains.length; index += 1) {
    const needle = expected.contains[index];
    const pass = includes(run.output, needle);
    scores.push({
      id: `contains:${index}`,
      kind: 'deterministic',
      pass,
      score: pass ? 1 : 0,
      reason: pass ? `Included “${needle}”.` : `Missing “${needle}”.`,
    });
  }
  for (let index = 0; index < expected.avoids.length; index += 1) {
    const needle = expected.avoids[index];
    const pass = !includes(run.output, needle);
    scores.push({
      id: `avoids:${index}`,
      kind: 'deterministic',
      pass,
      score: pass ? 1 : 0,
      reason: pass ? `Avoided “${needle}”.` : `Included disallowed “${needle}”.`,
    });
  }
  if (expected.requiredTool) {
    const pass = run.toolCalls.includes(expected.requiredTool);
    scores.push({
      id: 'required-tool',
      kind: 'deterministic',
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? `Selected ${expected.requiredTool}.`
        : `Did not select ${expected.requiredTool}.`,
    });
  }
  return scores;
}

function normalizedHookScore(
  definition: EvaluationScorerDefinition,
  raw: Partial<Pick<EvaluationScore, 'pass' | 'score' | 'reason'>>,
): EvaluationScore {
  const numeric = typeof raw.score === 'number' && Number.isFinite(raw.score)
    ? Math.max(0, Math.min(1, raw.score))
    : (raw.pass === true ? 1 : 0);
  const pass = typeof raw.pass === 'boolean' ? raw.pass : numeric >= 0.5;
  return {
    id: definition.id,
    kind: definition.kind,
    pass,
    score: numeric,
    reason: oneLine(raw.reason, pass ? 'Passed.' : 'Failed.'),
  };
}

/** Apply deterministic gates, then only the explicitly selected registered
 * hooks. A judge failure becomes a failed score instead of losing the rest of
 * an experiment. */
export async function evaluateAgentRun(
  context: EvaluationScorerContext,
  scorers: ReadonlyMap<string, EvaluationScorerDefinition> = new Map(),
): Promise<EvaluatedAgentRun> {
  const scores = scoreEvaluationDeterministically(context.scenario.expected, context.run);
  for (const scorerId of context.scenario.scorerIds) {
    const definition = scorers.get(scorerId);
    if (!definition) {
      scores.push({
        id: scorerId,
        kind: 'custom',
        pass: false,
        score: 0,
        reason: 'This scorer is not registered.',
      });
      continue;
    }
    try {
      // Sequential by design: a model judge can be rate-limited and score
      // ordering should match the versioned scenario configuration.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = definition.timeoutMs ?? EVALUATION_SCORER_TIMEOUT_MS;
      // eslint-disable-next-line no-await-in-loop
      const raw = await Promise.race([
        Promise.resolve(definition.evaluate({ ...context, signal: controller.signal })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('evaluation-scorer-timeout'));
          }, timeoutMs);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      scores.push(normalizedHookScore(definition, raw));
    } catch {
      scores.push({
        id: definition.id,
        kind: definition.kind,
        pass: false,
        score: 0,
        reason: 'The scorer could not complete.',
      });
    }
  }

  const status = context.run.error
    ? 'error'
    : (scores.every((score) => score.pass) ? 'passed' : 'failed');
  return { ...context.run, status, scores };
}

function toolNames(messages: AgentMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (typeof call.name === 'string' && call.name && !names.includes(call.name)) {
        names.push(call.name);
      }
    }
  }
  return names;
}

function fixtureBlock(fixtures?: EvaluationFixtures): string {
  if (!fixtures) return '';
  const sections: string[] = [];
  const list = (title: string, values?: string[]): void => {
    if (values?.length) sections.push(`### ${title}`, ...values.map((value) => `- ${value}`));
  };
  if (fixtures.constitution) sections.push('### Constitution', fixtures.constitution);
  list('Facts', fixtures.facts);
  list('Experiences', fixtures.experiences);
  list('Practices', fixtures.practices);
  return sections.length
    ? `## Evaluation fixture\n\nSynthetic context for this evaluation only.\n\n${sections.join('\n')}`
    : '';
}

function isolatedConfig(config: AgentConfig, fixtures?: EvaluationFixtures): AgentConfig {
  const fixture = fixtureBlock(fixtures);
  const originalInstructions = config.instructions;
  return {
    ...config,
    ...(fixture ? {
      instructions: (ctx) => {
        const source = typeof originalInstructions === 'function'
          ? originalInstructions(ctx)
          : Array.isArray(originalInstructions)
            ? originalInstructions.join('\n\n')
            : originalInstructions;
        return `${source}\n\n${fixture}`;
      },
    } : {}),
    // These five omissions are the non-contamination boundary. In particular,
    // identity must be absent: Experience and Practice are agent-owned, so an
    // ephemeral Session alone does not suppress their writes.
    identity: undefined,
    memory: undefined,
    experience: undefined,
    practice: undefined,
    approve: undefined,
    // Tool schemas remain visible to the provider. Dispatch fails closed before
    // every implementation, including subagents and MCP calls.
    canUse: async () => false,
  };
}

/** Run a configured Agent in a non-enumerable throwaway Session. It intentionally
 * does not call Agent#ask: ask preserves identity learning, while an evaluation
 * must be observational. Cleanup is part of success; a result is withheld if
 * temporary transcript erasure cannot be proved. */
export async function runIsolatedAgentEvaluation(
  agentId: string,
  prompt: string,
  opts: { instructionUserId: string; fixtures?: EvaluationFixtures },
): Promise<EvaluationAgentRun> {
  const config = getAgent(agentId);
  if (!config) {
    return {
      output: '', toolCalls: [], durationMs: 0,
      error: { code: 'no-agent', reason: 'Agent is unavailable.' },
    };
  }
  const sessionId = Random.id();
  const now = new Date();
  const started = Date.now();
  let captured: Omit<EvaluationAgentRun, 'durationMs'> = { output: '', toolCalls: [] };
  let created = false;

  try {
    // Null ownership keeps the temporary root out of every enumerable Session
    // publication. The real owner is used only to resolve dynamic instructions.
    await createInitialTranscript({
      _id: sessionId,
      agent: agentId,
      userId: null,
      phase: 'idle',
      model: config.model,
      nextSeq: 0,
      usage: { input: 0, output: 0, cost: 0 },
      budgetSpent: { turns: 0, toolCalls: 0 },
      ephemeral: true,
      archived: now,
      createdAt: now,
      updatedAt: now,
    }, {
      _id: Random.id(), role: 'user', content: prompt, createdAt: now,
    });
    created = true;

    await runTurn(
      sessionId,
      buildRunConfig(isolatedConfig(config, opts.fixtures), opts.instructionUserId, {
        agentName: agentId,
      }),
    );
    const [outcome, messages, session] = await Promise.all([
      readTurnOutcome(sessionId),
      AgentMessages.find({ sessionId }, { sort: { seq: 1 } }).fetchAsync(),
      AgentSessions.findOneAsync(sessionId),
    ]);
    const calls = toolNames(messages);
    if (outcome.ok) {
      captured = {
        output: outcome.text.slice(0, EVALUATION_TEXT_MAX),
        toolCalls: calls,
        ...(session?.usage ? { usage: { ...session.usage } } : {}),
      };
    } else {
      const reason = outcome.kind === 'parked'
        ? 'The evaluation unexpectedly waited for approval.'
        : outcome.kind === 'gone'
          ? 'The temporary evaluation session vanished.'
          : outcome.reason;
      captured = {
        output: '',
        toolCalls: calls,
        ...(session?.usage ? { usage: { ...session.usage } } : {}),
        error: { code: `evaluation-${outcome.kind}`, reason: oneLine(reason, 'Evaluation failed.') },
      };
    }
  } catch (error) {
    captured = {
      output: '',
      toolCalls: [],
      error: {
        code: error instanceof Meteor.Error && typeof error.error === 'string'
          ? error.error : 'evaluation-failed',
        reason: 'The evaluation could not complete.',
      },
    };
  } finally {
    if (created) {
      try {
        await eraseOwnedSession(agentId, sessionId, null);
      } catch {
        // Results from a session whose cleanup is uncertain are not evidence.
        captured = {
          output: '',
          toolCalls: [],
          error: {
            code: 'evaluation-cleanup-incomplete',
            reason: 'Temporary evaluation data cleanup is still pending.',
          },
        };
      }
    }
  }

  return {
    ...captured,
    durationMs: Math.max(0, Date.now() - started),
    model: config.model,
    agentVersion: config.version ?? 'unversioned',
  };
}

/** Validate application-registered hooks once at startup. */
export function evaluationScorerRegistry(
  definitions: EvaluationScorerDefinition[] = [],
): ReadonlyMap<string, EvaluationScorerDefinition> {
  const registry = new Map<string, EvaluationScorerDefinition>();
  for (const definition of definitions) {
    if (!definition || !/^[A-Za-z0-9._-]{1,80}$/.test(definition.id)
      || !definition.name?.trim()
      || !['custom', 'model'].includes(definition.kind)
      || (definition.timeoutMs !== undefined
        && (!Number.isSafeInteger(definition.timeoutMs)
          || definition.timeoutMs < 1
          || definition.timeoutMs > EVALUATION_SCORER_TIMEOUT_MAX_MS))
      || typeof definition.evaluate !== 'function') {
      throw new Error('[10thfloor:agent] invalid evaluation scorer definition');
    }
    if (registry.has(definition.id)) {
      throw new Error(`[10thfloor:agent] duplicate evaluation scorer: ${definition.id}`);
    }
    registry.set(definition.id, { ...definition, name: definition.name.trim().slice(0, 120) });
  }
  if (registry.size > EVALUATION_SCORER_MAX) {
    throw new Error(`[10thfloor:agent] at most ${EVALUATION_SCORER_MAX} scorers may be registered`);
  }
  return registry;
}
