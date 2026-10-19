import { assert } from 'chai';
import { AgentMessages, AgentSessions } from '../common/collections';
import { runTurn } from '../server/loop';
import { mockProvider } from '../server/providers/mock';
import { toolOutput } from '../server/tools';
import {
  AgentTraces, AgentTraceSpans, AgentTurnManifests, AgentEvidenceDebug,
  AgentEvidenceFeedback, listSessionEvidence, recordEvidenceFeedback, redactEvidence,
} from '../server/evidence';
import {
  AgentObservations, admitObservationExperience, dismissObservation,
  listSessionObservations, readObservationSources, reflectObservation, setObservationResolver,
  type ObservationExperienceDraft,
} from '../server/observations';
import { AgentExperiences } from '../server/learning-collections';
import { eraseOwnedSession } from '../server/session-lifecycle';
import type { ProviderRequest } from '../server/providers/types';

const prefix = 'evidence-test-';
let serial = 0;
const DRAFT: ObservationExperienceDraft = {
  expectationBasis: 'explicit', expected: 'The supplied URL would be reachable.',
  observed: 'The supplied URL returned a 404 response.',
  difference: 'The documentation had moved.', lesson: 'Verify the reference URL before citing it.',
  context: 'source verification', confidence: 0.95,
};

async function seed(): Promise<string> {
  const sessionId = `${prefix}${serial++}`;
  const now = new Date();
  await AgentSessions.insertAsync({ _id: sessionId, agent: `${sessionId}-agent`, userId: 'evidence-owner',
    phase: 'idle', model: 'mock', nextSeq: 1,
    usage: { input: 0, output: 0, cost: 0 }, budgetSpent: { turns: 0, toolCalls: 0 },
    createdAt: now, updatedAt: now });
  await AgentMessages.insertAsync({ _id: `${sessionId}:request`, sessionId, seq: 0, role: 'user',
    content: 'Check the reference URL before publishing.', createdAt: now });
  return sessionId;
}
async function observed(approval: 'ask' | 'auto' = 'ask') {
  const sessionId = await seed();
  await runTurn(sessionId, { agentName: `${sessionId}-agent`, model: 'mock', system: 'Check sources.', tools: [],
    identity: { id: `${sessionId}-identity`, name: `${sessionId}-agent` },
    experience: { record: true, recall: false, scope: 'owner', approval },
    provider: mockProvider(() => ({ text: 'The documentation URL returned 404. The current reference has moved.' })),
  });
  const rows = await listSessionObservations(sessionId);
  assert.lengthOf(rows, 1);
  return rows[0];
}
async function rejects(promise: Promise<unknown>, message: string): Promise<void> {
  let rejected = false;
  try { await promise; } catch (error) {
    rejected = true;
    assert.include((error as Error).message, message);
  }
  assert.isTrue(rejected, `expected ${message}`);
}

describe('Evidence, projections, and source-linked observation governance', () => {
  afterEach(async () => {
    setObservationResolver(undefined);
    const sessions = await AgentSessions.find({}).fetchAsync();
    for (const session of sessions.filter(({ _id }) => _id.startsWith(prefix))) {
      await eraseOwnedSession(session.agent, session._id, session.userId);
    }
  });

  it('records actual model/tool work while separating human, model, and private audit values', async () => {
    const sessionId = await seed();
    const requests: ProviderRequest[] = [];
    const inner = mockProvider((request) => request.messages.some((message) => message.role === 'tool')
      ? { text: 'Found three references.' }
      : { toolCalls: [{ id: 'reference-lookup', name: 'lookup', args: {} }] });
    await runTurn(sessionId, { model: 'mock', system: 'Find references.', tools: [{
      name: 'lookup', description: 'Look up references.', args: { type: 'object', properties: {} },
      run: async () => toolOutput({ model: { count: 3 }, display: 'Found 3 references',
        transcript: 'Three references were checked.', raw: { count: 3, apiKey: 'private-test-key', detail: 'private audit detail' } }),
    }], provider: { async *stream(request) { requests.push(request); yield* inner.stream(request); } } });
    const tool = await AgentMessages.findOneAsync({ sessionId, role: 'tool' });
    assert.equal(tool?.content, '{"count":3}');
    assert.equal(tool?.displayContent, 'Found 3 references');
    assert.equal(tool?.transcriptContent, 'Three references were checked.');
    assert.notInclude(JSON.stringify(requests), 'private audit detail');
    assert.notInclude(JSON.stringify(tool), 'auditValue');
    const normal = await listSessionEvidence(sessionId);
    assert.lengthOf(normal.traces, 1);
    assert.equal(normal.traces[0].status, 'completed');
    assert.lengthOf(normal.spans.filter(({ kind }) => kind === 'model'), 2);
    assert.lengthOf(normal.spans.filter(({ kind }) => kind === 'tool'), 1);
    assert.deepEqual(normal.manifests[0].tools.map(({ name }) => name), ['lookup']);
    assert.notProperty(normal, 'debug');
    assert.notInclude(JSON.stringify(normal), 'private audit detail');
    const debug = await listSessionEvidence(sessionId, { includeDebug: true });
    assert.include(JSON.stringify(debug), 'private audit detail');
    assert.notInclude(JSON.stringify(debug), 'private-test-key');
  });

  it('freezes memory provenance and links an observation to exact original messages', async () => {
    const row = await observed();
    const source = await readObservationSources(row._id);
    assert.deepEqual(source.map(({ _id }) => _id), row.sources.map(({ id }) => id));
    const evidence = await listSessionEvidence(row.sessionId);
    assert.equal(evidence.manifests[0].memoryFrameId, row.frameId);
    assert.equal(evidence.manifests[0].agentId, row.agentId);
    assert.isString(evidence.manifests[0].frameDigest);
    assert.equal(row.status, 'recorded');
    assert.equal(await AgentExperiences.find({ agentId: row.agentId }).countAsync(), 0);
  });

  it('does not attribute an unseen mid-stream interjection to the completed reply', async () => {
    const sessionId = await seed();
    await runTurn(sessionId, { agentName: `${sessionId}-agent`, model: 'mock', system: '', tools: [],
      identity: { id: `${sessionId}-identity`, name: `${sessionId}-agent` },
      experience: { record: true, recall: false, scope: 'owner', approval: 'ask' },
      provider: { async *stream() {
        yield { kind: 'text', chunk: 'The reference was checked.' };
        await AgentMessages.insertAsync({ _id: `${sessionId}:late`, sessionId, seq: 1, role: 'user',
          content: 'This is a later task the model has not seen.', createdAt: new Date() });
        await AgentSessions.updateAsync(sessionId, { $set: { nextSeq: 2 } });
        yield { kind: 'done' };
      } },
    });
    const rows = await listSessionObservations(sessionId);
    assert.lengthOf(rows, 1);
    assert.notInclude(rows[0].sources.map(({ id }) => id), `${sessionId}:late`);
    assert.notInclude(rows[0].summary, 'later task');
  });

  it('requires review under reviewed policy and records a replay-safe reviewed experience', async () => {
    const row = await observed();
    const candidate = await reflectObservation(row._id, { draft: DRAFT });
    assert.equal(candidate.status, 'candidate');
    assert.equal(await AgentExperiences.find({ agentId: row.agentId }).countAsync(), 0);
    await rejects(admitObservationExperience(row._id, { automatic: true }), 'requires a person');
    const admitted = await admitObservationExperience(row._id, { actorId: 'evidence-owner' });
    assert.equal(admitted.status, 'admitted');
    const replay = await admitObservationExperience(row._id, { actorId: 'evidence-owner' });
    assert.equal(replay.experienceId, admitted.experienceId);
    assert.equal(await AgentExperiences.find({ agentId: row.agentId }).countAsync(), 1);
    const experience = await AgentExperiences.findOneAsync(admitted.experienceId!);
    assert.equal(experience?.admission, 'reviewed');
    assert.equal(experience?.source.key, `observation:${row._id}`);
    assert.equal(experience?.audience.key, 'evidence-owner');
  });

  it('automatically admits resolver candidates only under the frozen automatic policy', async () => {
    const row = await observed('auto');
    setObservationResolver(async ({ messages }) => {
      assert.lengthOf(messages, row.sources.length);
      return { summary: 'The reference was checked and had moved.', experience: DRAFT };
    });
    const admitted = await reflectObservation(row._id);
    assert.equal(admitted.status, 'admitted');
    const experience = await AgentExperiences.findOneAsync(admitted.experienceId!);
    assert.equal(experience?.admission, 'automatic');
    assert.isUndefined(experience?.review, 'automatic experiences remain pending audit');
  });

  it('refuses stale sources and dismissed candidates before identity memory changes', async () => {
    const row = await observed();
    await reflectObservation(row._id, { draft: DRAFT });
    await AgentMessages.updateAsync(row.sources[0].id, { $set: { content: 'Changed source' } });
    await rejects(admitObservationExperience(row._id, { actorId: 'evidence-owner' }), 'source messages changed');
    await dismissObservation(row._id, 'evidence-owner');
    await rejects(admitObservationExperience(row._id, { actorId: 'evidence-owner' }), 'Reflect on this observation');
    assert.equal(await AgentExperiences.find({ agentId: row.agentId }).countAsync(), 0);
  });

  it('keeps one feedback verdict per reviewer and erases all conversation-owned evidence', async () => {
    const row = await observed();
    const { traces } = await listSessionEvidence(row.sessionId);
    await recordEvidenceFeedback({ traceId: traces[0]._id, actorId: 'evidence-owner', rating: 'unhelpful', note: 'Needs a working link.' });
    await recordEvidenceFeedback({ traceId: traces[0]._id, actorId: 'evidence-owner', rating: 'helpful' });
    const before = await listSessionEvidence(row.sessionId);
    assert.lengthOf(before.feedback, 1);
    assert.equal(before.feedback[0].rating, 'helpful');
    await eraseOwnedSession(`${row.sessionId}-agent`, row.sessionId, 'evidence-owner');
    for (const collection of [AgentTraces, AgentTraceSpans, AgentTurnManifests, AgentEvidenceDebug, AgentEvidenceFeedback, AgentObservations]) {
      assert.equal(await (collection as any).find({ sessionId: row.sessionId }).countAsync(), 0);
    }
  });

  it('redacts structured credentials and bounded free text before exposing debug data', () => {
    const safe = redactEvidence({ password: 'secret-value', nested: { authorization: 'Bearer sensitive-token' },
      text: 'api_key=abc123 Bearer abcdefghijk sk-abcdefghijklmnopq' });
    assert.notInclude(JSON.stringify(safe), 'secret-value');
    assert.notInclude(JSON.stringify(safe), 'sensitive-token');
    assert.notInclude(JSON.stringify(safe), 'abc123');
    assert.notInclude(JSON.stringify(safe), 'abcdefghijklmnopq');
  });
});
