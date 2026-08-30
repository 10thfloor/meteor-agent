export const CHANNEL_SCHEMAS = Object.freeze({
  slack: Object.freeze({
    label: 'Slack',
    fields: Object.freeze([
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: 'xoxb-…' },
      { key: 'signingSecret', label: 'Signing secret', secret: true },
    ]),
  }),
  telegram: Object.freeze({
    label: 'Telegram',
    fields: Object.freeze([
      { key: 'botToken', label: 'Bot token', secret: true, placeholder: '123456:…' },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true },
    ]),
  }),
  whatsapp: Object.freeze({
    label: 'WhatsApp',
    fields: Object.freeze([
      { key: 'accessToken', label: 'Access token', secret: true },
      { key: 'appSecret', label: 'App secret', secret: true },
      { key: 'verifyToken', label: 'Verify token', secret: true },
    ]),
  }),
  sms: Object.freeze({
    label: 'SMS',
    fields: Object.freeze([
      { key: 'accountSid', label: 'Account SID', secret: true, placeholder: 'AC…' },
      { key: 'authToken', label: 'Auth token', secret: true },
      { key: 'webhookUrl', label: 'Public webhook URL', secret: false, type: 'url' },
    ]),
  }),
  email: Object.freeze({
    label: 'Email',
    fields: Object.freeze([
      { key: 'serverToken', label: 'Server token', secret: true },
      { key: 'from', label: 'From address', secret: false, type: 'email' },
      { key: 'inboundAddress', label: 'Inbound address', secret: false, type: 'email' },
      { key: 'webhookUser', label: 'Webhook user', secret: true },
      { key: 'webhookPassword', label: 'Webhook password', secret: true },
    ]),
  }),
});

export const CHANNEL_KINDS = Object.freeze(Object.keys(CHANNEL_SCHEMAS));

const CRON_RANGES = Object.freeze([
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]);

function parseCronPart(part, min, max, normalize = (value) => value) {
  const values = new Set();
  for (const segment of part.split(',')) {
    const [rangePart, stepText] = segment.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) {
      throw new Error('Cron steps must be positive integers.');
    }
    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (/^\d+$/.test(rangePart)) {
      start = Number(rangePart);
      end = start;
    } else {
      const match = rangePart.match(/^(\d+)-(\d+)$/);
      if (!match) throw new Error('Cron fields support *, values, ranges, lists, and steps.');
      start = Number(match[1]);
      end = Number(match[2]);
    }
    if (start < min || end > max || start > end) throw new Error('Cron value is out of range.');
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  return values;
}

export function parseCron(expression) {
  const clean = String(expression ?? '').trim().replace(/\s+/g, ' ');
  const parts = clean.split(' ');
  if (parts.length !== 5) throw new Error('Cron must contain five fields.');
  const sets = parts.map((part, index) => parseCronPart(
    part,
    CRON_RANGES[index][0],
    CRON_RANGES[index][1],
    index === 4 ? (value) => (value === 7 ? 0 : value) : undefined,
  ));
  return {
    expression: clean,
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays: sets[4],
    dayWildcard: parts[2] === '*',
    weekdayWildcard: parts[4] === '*',
  };
}

function cronMatches(parsed, value) {
  if (!parsed.minutes.has(value.getMinutes()) || !parsed.hours.has(value.getHours())) return false;
  if (!parsed.months.has(value.getMonth() + 1)) return false;
  const dayMatches = parsed.days.has(value.getDate());
  const weekdayMatches = parsed.weekdays.has(value.getDay());
  if (parsed.dayWildcard) return weekdayMatches;
  if (parsed.weekdayWildcard) return dayMatches;
  return dayMatches || weekdayMatches;
}

export function normalizeSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('Schedule is required.');
  if (input.kind === 'interval') {
    const every = Number(input.every);
    const unit = input.unit;
    if (!Number.isInteger(every) || every < 1 || every > 10_080) {
      throw new Error('Interval must be between 1 and 10,080.');
    }
    if (!['minutes', 'hours', 'days'].includes(unit)) throw new Error('Unknown interval unit.');
    const minutes = every * ({ minutes: 1, hours: 60, days: 1440 }[unit]);
    if (minutes > 525_600) throw new Error('Interval cannot exceed one year.');
    return { kind: 'interval', every, unit };
  }
  if (input.kind === 'cron') {
    const parsed = parseCron(input.expression);
    return { kind: 'cron', expression: parsed.expression };
  }
  throw new Error('Schedule must be interval or cron.');
}

export function nextScheduledAt(schedule, after = new Date()) {
  const normalized = normalizeSchedule(schedule);
  const start = new Date(after);
  if (!Number.isFinite(start.getTime())) throw new Error('Invalid schedule start time.');
  if (normalized.kind === 'interval') {
    const minutes = normalized.every * ({ minutes: 1, hours: 60, days: 1440 }[normalized.unit]);
    return new Date(start.getTime() + minutes * 60_000);
  }
  const parsed = parseCron(normalized.expression);
  const candidate = new Date(start);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = 2 * 366 * 24 * 60;
  for (let offset = 0; offset < limit; offset += 1) {
    if (cronMatches(parsed, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error('Cron has no run time in the next two years.');
}

export function scheduleLabel(schedule) {
  const normalized = normalizeSchedule(schedule);
  if (normalized.kind === 'cron') return normalized.expression;
  const singular = normalized.unit.slice(0, -1);
  return normalized.every === 1 ? `Every ${singular}` : `Every ${normalized.every} ${normalized.unit}`;
}

export function slugifySkill(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function runtimeAgentFromMessage(message) {
  const participant = message?.from?.participant;
  return participant?.startsWith('m:') ? participant.slice(2) : null;
}

function runtimeUnansweredUser(messages) {
  // Crew notes are durable human context, not work owed by an agent. Treating
  // the newest note as an unanswered prompt would leave an idle Mission stuck
  // in a false loading state forever.
  const user = [...messages].reverse().find(
    (message) => message.role === 'user' && message.kind !== 'crew-note',
  );
  if (!user) return null;
  return messages.some((message) => message.role === 'assistant' && message.seq > user.seq)
    ? null
    : user;
}

function runtimePendingTool(messages, session) {
  const answered = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
  );
  const calls = messages.flatMap((message) => message.toolCalls ?? []);
  if (session?.activeChild?.toolCallId) {
    const childCall = calls.find((call) => call.id === session.activeChild.toolCallId);
    if (childCall) return childCall;
  }
  return [...calls].reverse().find((call) => !answered.has(call.id)) ?? null;
}

function runtimeToolLabel(value) {
  return String(value ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function addressedAgent(message) {
  return message?.to?.startsWith('m:') ? message.to.slice(2) : null;
}

/**
 * Collapse meteor-agent's durable phases and wake markers into a stable UI
 * state. This is intentionally pure: callers can use the same mapping in the
 * mission header, list, crew, and tests without timing-dependent local flags.
 */
export function deriveRuntimeState(session, messageRows = []) {
  const messages = Array.isArray(messageRows) ? messageRows : [];
  if (!session) {
    return {
      key: 'loading', label: 'Loading', detail: 'Loading mission',
      runtimePhase: 'idle', agent: null,
    };
  }

  const runtimePhase = session.phase ?? 'idle';
  const live = [...messages].reverse().find((message) => message.streaming);
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const unansweredUser = runtimeUnansweredUser(messages);
  const pendingTool = runtimePendingTool(messages, session);
  const lastModel = runtimeAgentFromMessage(live)
    ?? runtimeAgentFromMessage(lastAssistant)
    ?? session.agent
    ?? null;

  if (runtimePhase === 'error') {
    const failure = [...messages].reverse().find((message) => message.kind === 'error');
    return {
      key: 'error', label: 'Error', detail: failure?.error?.reason || 'Agent error',
      runtimePhase, agent: lastModel,
    };
  }
  if (runtimePhase === 'stopped') {
    return {
      key: 'stopped', label: 'Stopped', detail: 'Run stopped',
      runtimePhase, agent: lastModel,
    };
  }
  if (runtimePhase === 'awaiting' || (session.pending && !session.pending.verdict)) {
    const tool = runtimeToolLabel(session.pending?.name);
    return {
      key: 'waiting', label: 'Approval needed',
      detail: tool ? `Approval · ${tool}` : 'Approval needed',
      runtimePhase, agent: session.pending?.agent ?? lastModel,
    };
  }
  if (runtimePhase === 'retrying') {
    return {
      key: 'retrying', label: 'Retrying', detail: 'Retrying',
      runtimePhase, agent: lastModel,
    };
  }
  if (session.activeChild) {
    const specialist = pendingTool?.name ?? null;
    return {
      key: 'working', label: 'Working',
      detail: specialist ? `${runtimeToolLabel(specialist)} run` : 'Delegated run',
      // `activeChild` intentionally carries no agent name. The exact name is
      // available from the parent tool call once that transcript row arrives;
      // until then, null is more truthful than attributing the child to primary.
      runtimePhase, agent: specialist,
    };
  }
  if (runtimePhase === 'calling') {
    const tool = runtimeToolLabel(pendingTool?.name);
    return {
      key: 'working', label: 'Working',
      detail: tool ? `Running ${tool}` : 'Running tool',
      runtimePhase, agent: lastModel,
    };
  }
  if (runtimePhase === 'compacting') {
    return {
      key: 'working', label: 'Working', detail: 'Compacting',
      runtimePhase, agent: lastModel,
    };
  }
  if (runtimePhase === 'streaming') {
    return live?.content?.trim()
      ? {
        key: 'working', label: 'Working', detail: 'Responding',
        runtimePhase, agent: lastModel,
      }
      : {
        key: 'thinking', label: 'Thinking', detail: 'Thinking',
        runtimePhase, agent: lastModel,
      };
  }

  if (session.pending?.verdict) {
    return {
      key: 'loading', label: 'Loading', detail: 'Resuming',
      runtimePhase, agent: session.pending?.agent ?? lastModel,
    };
  }
  if (session.pendingRelay) {
    return {
      key: 'loading', label: 'Loading', detail: 'Handoff queued',
      runtimePhase, agent: session.pendingRelay.agent ?? null,
    };
  }
  if (session.pendingSystem) {
    return {
      key: 'loading', label: 'Loading', detail: 'Pulse queued',
      runtimePhase, agent: session.pendingSystem.agent ?? session.agent ?? null,
    };
  }
  if (unansweredUser) {
    return {
      key: 'loading', label: 'Loading', detail: 'Queued',
      runtimePhase, agent: addressedAgent(unansweredUser) ?? session.agent ?? null,
    };
  }
  return {
    key: 'ready', label: 'Ready', detail: 'Ready',
    runtimePhase, agent: null,
  };
}
