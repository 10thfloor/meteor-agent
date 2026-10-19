// Provider-neutral, browser-safe validation for locally owned decision nodes.
export const DECISION_TOOL_NAMES = ['find_decision_nodes', 'create_decision_node', 'evaluate_decision_node'];
export const DECISION_DEFAULT_LIMITS = Object.freeze({ callsPerMission: 20, tokensPerMission: 100_000, maxInputChars: 12_000 });
export const DECISION_DEFAULT_POLICY = Object.freeze({ use: false, create: 'disabled' });
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export class DecisionValidationError extends Error {
  constructor(reason) { super(reason); this.error = 'invalid-decision'; this.reason = reason; }
}
export function decisionInvalid(reason) { throw new DecisionValidationError(reason); }
export function decisionObject(value, label = 'Value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) decisionInvalid(`${label} must be an object.`);
  return value;
}
export function decisionText(value, label, max = 120, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) decisionInvalid(`${label} must contain ${optional ? '0' : '1'}–${max} characters.`);
  return value.trim();
}
export function decisionKey(value, label = 'Field name') {
  if (typeof value !== 'string' || !keyPattern.test(value) || forbidden.has(value)) decisionInvalid(`${label} must start with a letter and use only letters, numbers, underscores or hyphens.`);
  return value;
}
export function decisionJson(value, label = 'Context', max = 32_000) {
  let size = 0;
  const visit = (item, depth) => {
    if (depth > 12) decisionInvalid(`${label} is nested too deeply.`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) decisionInvalid(`${label} contains an invalid number.`); return item; }
    if (typeof item === 'string') { size += item.length; if (size > max) decisionInvalid(`${label} is too long.`); return item; }
    if (Array.isArray(item)) { if (item.length > 512) decisionInvalid(`${label} has too many items.`); return item.map((x) => visit(x, depth + 1)); }
    decisionObject(item, label);
    const entries = Object.entries(item);
    if (entries.length > 512 || entries.some(([key]) => forbidden.has(key) || key.includes('.') || key.startsWith('$'))) decisionInvalid(`${label} contains an unsupported field.`);
    return Object.fromEntries(entries.map(([key, child]) => [key, visit(child, depth + 1)]));
  };
  const result = visit(value, 0);
  if (JSON.stringify(result).length > max) decisionInvalid(`${label} is too long (maximum ${max} characters).`);
  return result;
}
function instructions(value, label) {
  if (typeof value === 'string') return decisionText(value, label, 8_000);
  if (!value || typeof value !== 'object') decisionInvalid(`${label} must be text or structured instructions.`);
  const result = decisionJson(value, label, 8_000);
  if (!Object.keys(result).length) decisionInvalid(`${label} cannot be empty.`);
  return result;
}
export function normalizeDecisionDefinition(input) {
  decisionObject(input, 'Definition');
  const model = decisionText(input.model ?? 'jev-latest', 'Model', 100);
  if (!/^jev-[a-zA-Z0-9.-]+$/.test(model)) decisionInvalid('Choose a Jev model.');
  const source = decisionObject(input.questions, 'Questions');
  if (!Object.keys(source).length || Object.keys(source).length > 16) decisionInvalid('Add between 1 and 16 independent questions.');
  const questions = Object.fromEntries(Object.entries(source).map(([id, question]) => {
    decisionKey(id, 'Question ID'); decisionObject(question, 'Question');
    const { type } = question;
    if (!['choice', 'score', 'noul'].includes(type)) decisionInvalid('Choose Choice, Score or Yes / no.');
    const result = { type, instructions: instructions(question.instructions, 'Question') };
    if (type === 'choice') {
      const criteria = decisionObject(question.criteria, 'Options');
      if (Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255) decisionInvalid('Choice needs 2–255 options.');
      result.criteria = Object.fromEntries(Object.entries(criteria).map(([key, value]) => {
        decisionKey(key, 'Option ID'); return [key, value === null ? null : instructions(value, 'Option description')];
      }));
    } else if (type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) decisionInvalid('Score needs 2–10 ordered levels.');
      result.criteria = question.criteria.map((value) => instructions(value, 'Level description'));
    } else if (question.criteria !== undefined) {
      const criteria = decisionObject(question.criteria, 'Yes / no meanings');
      if (Object.keys(criteria).some((key) => !['true', 'false'].includes(key))) decisionInvalid('Yes / no criteria may contain only true and false.');
      result.criteria = Object.fromEntries(Object.entries(criteria).map(([key, value]) => [key, instructions(value, 'Meaning')]));
    }
    return [id, result];
  }));
  return decisionJson({ model, questions }, 'Definition', 48_000);
}
export function normalizeDecisionInputFields(value = [{ key: 'context', label: 'Context', type: 'text', required: true }]) {
  if (!Array.isArray(value) || !value.length || value.length > 24) decisionInvalid('Add between 1 and 24 input fields.');
  const seen = new Set();
  return value.map((field) => {
    decisionObject(field, 'Input field'); const key = decisionKey(field.key);
    if (seen.has(key)) decisionInvalid('Input field names must be unique.'); seen.add(key);
    if (!['text', 'number', 'boolean'].includes(field.type)) decisionInvalid('Choose a text, number or yes / no input.');
    return { key, label: decisionText(field.label ?? key, 'Input label'), type: field.type, required: field.required !== false };
  });
}
export function normalizeDecisionState(state, node, max = 32_000) {
  const clean = decisionJson(state, 'Context', max);
  // Plain text remains convenient for tool calls and workflow dependency text.
  if (typeof clean === 'string' && node.inputFields.length === 1 && node.inputFields[0].type === 'text') return normalizeDecisionState({ [node.inputFields[0].key]: clean }, node, max);
  decisionObject(clean, 'Context');
  if (Object.keys(clean).some((key) => !node.inputFields.some((field) => field.key === key))) decisionInvalid('Context contains an input not declared by this decision.');
  for (const field of node.inputFields) {
    const item = clean[field.key];
    if (item === undefined || item === null || item === '') { if (field.required) decisionInvalid(`${field.label} is required.`); continue; }
    if (typeof item !== (field.type === 'text' ? 'string' : field.type)) decisionInvalid(`${field.label} must be ${field.type}.`);
  }
  return clean;
}
export function normalizeDecisionFixtures(value = [], definition, inputFields) {
  if (!Array.isArray(value) || value.length > 30) decisionInvalid('Use at most 30 test cases.');
  const seen = new Set();
  return value.map((item, index) => {
    decisionObject(item, 'Test case'); const id = decisionKey(item.id ?? `case_${index + 1}`, 'Test ID');
    if (seen.has(id)) decisionInvalid('Test IDs must be unique.'); seen.add(id);
    const expected = decisionObject(item.expected, 'Expected answers');
    if (!Object.keys(expected).length) decisionInvalid('Add at least one expected answer per test.');
    const cleanExpected = Object.fromEntries(Object.entries(expected).map(([questionId, answer]) => {
      const question = definition.questions[questionId]; if (!question) decisionInvalid('A test refers to an unknown question.');
      if (question.type === 'choice') {
        if (typeof answer !== 'string' || !Object.hasOwn(question.criteria, answer)) decisionInvalid('Expected choice must be one of the options.');
        return [questionId, answer];
      }
      decisionObject(answer, 'Expected range');
      const limit = question.type === 'noul' ? 1 : question.criteria.length - 1;
      if (![answer.min, answer.max].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= limit) || answer.min > answer.max) decisionInvalid(`Expected range must be between 0 and ${limit}.`);
      return [questionId, { min: answer.min, max: answer.max }];
    }));
    return { id, name: decisionText(item.name ?? `Test ${index + 1}`, 'Test name'), state: normalizeDecisionState(item.state, { inputFields }), expected: cleanExpected };
  });
}
export function normalizeDecisionNode(input) {
  decisionObject(input, 'Decision');
  const definition = normalizeDecisionDefinition(input.definition);
  const inputFields = normalizeDecisionInputFields(input.inputFields);
  const scope = input.scope ?? 'workspace';
  if (!['workspace', 'mission'].includes(scope)) decisionInvalid('Choose workspace or mission scope.');
  if (!Array.isArray(input.agentIds ?? []) || (input.agentIds ?? []).length > 64) decisionInvalid('Agent selection is invalid.');
  return { name: decisionText(input.name, 'Decision name'), description: decisionText(input.description ?? '', 'Description', 1_000, true),
    scope, ...(scope === 'mission' ? { missionId: decisionText(input.missionId, 'Mission', 120) } : {}),
    enabled: input.enabled !== false, agentIds: [...new Set((input.agentIds ?? []).map((id) => decisionText(id, 'Agent', 120)))],
    inputFields, definition, fixtures: normalizeDecisionFixtures(input.fixtures, definition, inputFields) };
}
export function normalizeDecisionLimits(value = {}) {
  decisionObject(value, 'Limits');
  const result = { ...DECISION_DEFAULT_LIMITS, ...value };
  const ranges = { callsPerMission: [1, 200], tokensPerMission: [1_000, 2_000_000], maxInputChars: [256, 32_000] };
  if (Object.keys(result).some((key) => !ranges[key])) decisionInvalid('Unknown decision limit.');
  for (const [key, [min, max]] of Object.entries(ranges)) if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) decisionInvalid(`${key} must be between ${min} and ${max}.`);
  return result;
}
export function normalizeDecisionPolicy(value) {
  decisionObject(value, 'Agent access');
  if (typeof value.use !== 'boolean' || !['disabled', 'ask', 'auto'].includes(value.create)) decisionInvalid('Choose whether this agent may use and create decisions.');
  return { use: value.use, create: value.create };
}
export function validateDecisionResponse(response, definition) {
  decisionObject(response, 'TypeSafe response');
  const answers = decisionObject(response.answers, 'TypeSafe answers');
  const probability = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  if (Object.keys(answers).length !== Object.keys(definition.questions).length) decisionInvalid('TypeSafe returned an unexpected answer set.');
  const cleanAnswers = {};
  for (const [id, question] of Object.entries(definition.questions)) {
    const answer = answers[id];
    if (!answer || answer.type !== question.type) decisionInvalid('TypeSafe returned an unexpected answer type.');
    if (question.type === 'noul') { if (!probability(answer.noul)) decisionInvalid('TypeSafe returned an invalid probability.'); cleanAnswers[id] = { type: 'noul', noul: answer.noul }; continue; }
    if (!probability(answer.confidence)) decisionInvalid('TypeSafe returned invalid confidence.');
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    decisionObject(answer.probabilities, 'Answer probabilities');
    if (Object.keys(answer.probabilities).length !== keys.length || keys.some((key) => !probability(answer.probabilities[key])) || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02) decisionInvalid('TypeSafe returned an invalid distribution.');
    if (question.type === 'choice' && !keys.includes(answer.choice)) decisionInvalid('TypeSafe returned an unknown choice.');
    if (question.type === 'score' && (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1)) decisionInvalid('TypeSafe returned an invalid score.');
    if (question.type === 'score') {
      decisionObject(answer.legend, 'Score legend');
      if (Object.keys(answer.legend).length !== keys.length || keys.some((key) => typeof answer.legend[key] !== 'string')) decisionInvalid('TypeSafe returned an invalid score legend.');
    }
    cleanAnswers[id] = { type: question.type, ...(question.type === 'choice' ? { choice: answer.choice } : { score: answer.score, legend: answer.legend }),
      confidence: answer.confidence, probabilities: answer.probabilities };
  }
  const usage = decisionObject(response.usage, 'Token usage');
  if (![usage.input_tokens, usage.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)) decisionInvalid('TypeSafe did not return valid token usage.');
  return { model: decisionText(response.model, 'Returned model', 100), answers: decisionJson(cleanAnswers, 'Answers', 256_000), usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } };
}
export function decisionAssertions(expected, answers) {
  return Object.entries(expected).map(([questionId, target]) => {
    const answer = answers[questionId];
    const actual = answer?.choice ?? answer?.score ?? answer?.noul;
    const passed = typeof target === 'string' ? actual === target : typeof actual === 'number' && actual >= target.min && actual <= target.max;
    return { questionId, expected: target, actual, passed };
  });
}
export function decisionAnswerLabel(answers = {}) {
  return Object.entries(answers).map(([id, answer]) => `${id.replace(/_/g, ' ')}: ${answer.type === 'choice' ? answer.choice.replace(/_/g, ' ') : answer.type === 'noul' ? `${Math.round(answer.noul * 100)}% yes` : Number(answer.score).toFixed(2)}`).join(' · ');
}
