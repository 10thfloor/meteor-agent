import { assert } from 'chai';
import { resolveDecisionWorkMessage } from '../imports/constellation/decision-work-target';

describe('Constellation decision continuation work target', function () {
  const options = { sessionId: 'mission', key: 'decision-approved:node:2', agent: 'researcher' };
  const row = (seq, role, fields = {}) => ({
    _id: `message-${seq}`, sessionId: options.sessionId, seq, role, streaming: false, ...fields,
  });
  const input = row(2, 'user', { content: 'Please evaluate this.' });
  const trigger = row(5, 'system', { _id: `sys:${options.sessionId}:${options.key}`,
    content: 'Internal continuation instructions', from: { participant: 's:decision-review' }, to: 'm:researcher' });
  const reply = (seq, fields = {}) => row(seq, 'assistant', {
    content: 'The decision passed.', answeredThrough: 2, from: { participant: 'm:researcher' }, ...fields,
  });
  const call = reply(6, { content: '', toolCalls: [{ id: 'evaluate', name: 'evaluate_decision_node' }] });
  const resolve = (after = [], before = [input, trigger]) => resolveDecisionWorkMessage([...before, ...after], options);

  it('chooses the exact continuation result, not a later human response', () => {
    assert.equal(resolve([call, row(7, 'tool', { toolCallId: 'evaluate' }), reply(8),
      row(9, 'user', { content: 'Another task' }), reply(10, { answeredThrough: 9 })]), 'message-8');
  });

  it('prefers the latest final answer over intermediate text and tool-only chatter', () => {
    assert.equal(resolve([call, row(7, 'tool', { toolCallId: 'evaluate' }), reply(8),
      reply(9, { content: 'Additional result.' }), reply(10, { content: '', toolCalls: [{ id: 'extra' }] })]), 'message-9');
  });

  it('uses answeredThrough to retain an old reply committed after a human interjection', () => {
    assert.equal(resolve([row(6, 'user', { content: 'Next task' }), reply(7),
      reply(8, { answeredThrough: 6 })]), 'message-7');
    assert.isNull(resolve([row(6, 'user'), reply(7, { answeredThrough: undefined })]));
    assert.isNull(resolve([row(6, 'user'), reply(7, { answeredThrough: 6 })]));
  });

  it('does not mistake crew notes for a new request', () => {
    assert.equal(resolve([row(6, 'user', { kind: 'crew-note', content: 'A useful detail.' }),
      reply(7, { answeredThrough: 6 })]), 'message-7');
  });

  it('stops at a later system turn even when the user watermark is unchanged', () => {
    assert.equal(resolve([reply(6), row(7, 'system', { _id: 'sys:mission:other' }), reply(8)]), 'message-6');
    assert.isNull(resolve([row(6, 'system', { _id: 'sys:mission:other' }), reply(7)]));
  });

  it('does not follow a relay into another agent turn', () => {
    assert.isNull(resolve([reply(6, { to: 'm:operator' }),
      reply(7, { from: { participant: 'm:operator' } }), reply(8)]));
  });

  it('filters roster actors without guessing from display names', () => {
    assert.equal(resolve([reply(6), reply(7, { from: { participant: 'm:operator', name: 'Signal' } })]), 'message-6');
    assert.isNull(resolve([reply(6, { from: { participant: 'h:owner', name: 'Signal' } })]));
    assert.equal(resolve([reply(6, { from: undefined })]), 'message-6', 'legacy one-to-one rows have no actor stamp');
  });

  it('returns null until committed visible work exists', () => {
    assert.isNull(resolve());
    assert.isNull(resolve([reply(6, { streaming: true })]));
    assert.isNull(resolve([reply(6, { content: '', thinking: 'Internal reasoning' })]));
    assert.isNull(resolve([row(6, 'note', { kind: 'compaction' })]));
  });

  it('falls back to a linked operation or pending approval proposal', () => {
    assert.equal(resolve([call]), 'message-6');
    assert.equal(resolve([call, row(7, 'tool', { toolCallId: 'evaluate', content: '{"passed":true}' })]), 'message-7');
    assert.equal(resolve([call, row(7, 'note', { kind: 'approval', toolCallId: 'evaluate', approved: false })]), 'message-7');
    assert.isNull(resolve([row(6, 'tool', { toolCallId: 'unknown', content: 'Unrelated result' })]));
  });

  it('finds an exact failure receipt but not failures caused by later input', () => {
    assert.equal(resolve([row(6, 'note', { kind: 'error', error: { reason: 'Provider failed.' } })]), 'message-6');
    assert.equal(resolve([call, row(7, 'tool', { toolCallId: 'evaluate', error: { reason: 'Failed.' } })]), 'message-7');
    assert.isNull(resolve([row(6, 'user'), row(7, 'note', { kind: 'error' })]));
    assert.isNull(resolve([reply(6, { content: '', from: { participant: 'm:operator' } }),
      row(7, 'note', { kind: 'error' })]));
  });

  it('does not match reused tool ids across another assistant response', () => {
    assert.equal(resolve([call, reply(7, { content: '', from: { participant: 'm:operator' },
      toolCalls: [{ id: 'evaluate' }] }), row(8, 'tool', { toolCallId: 'evaluate' })]), 'message-6');
  });

  it('does not pick a different session, missing trigger, or forged trigger shape', () => {
    assert.isNull(resolve([reply(6)], [input]));
    assert.isNull(resolve([reply(6)], [input, { ...trigger, role: 'user' }]));
    assert.isNull(resolve([reply(6)], [input, { ...trigger, to: 'm:operator' }]));
    assert.isNull(resolve([reply(6)], [input, { ...trigger, from: { participant: 's:pulse' } }]));
    assert.isNull(resolve([{ ...reply(6), sessionId: 'another-mission' }]));
  });

  it('rejects ambiguous rows and impossible answer watermarks', () => {
    assert.isNull(resolve([reply(6), { ...reply(6), _id: 'duplicate-sequence' }]));
    assert.isNull(resolve([reply(6)], [input, trigger, { ...trigger }]));
    assert.isNull(resolve([reply(6, { answeredThrough: 6 })]));
    assert.isNull(resolve([reply(6, { answeredThrough: 1 })]));
    assert.isNull(resolve([reply(6, { answeredThrough: NaN })]));
  });

  it('accepts unsorted input without mutating the supplied rows', () => {
    const rows = [reply(8), trigger, input, call];
    const before = [...rows];
    assert.equal(resolveDecisionWorkMessage(rows, options), 'message-8');
    assert.deepEqual(rows, before);
    assert.isNull(resolveDecisionWorkMessage(null, options));
    assert.isNull(resolveDecisionWorkMessage(rows, { ...options, key: '' }));
  });
});
