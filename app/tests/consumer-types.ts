/** Compile-only fixture: imports exactly the declaration entries a vendored
 * consumer receives, rather than the source paths used by package tests. */
import {
  Agent, ClientAgent, NAMES, tool,
  type AgentConfig, type AgentSession, type DeliverOnceOptions,
  type Provider, type SessionErasure,
} from 'meteor/10thfloor:agent';
import { slack, type SlackChannelOptions } from 'meteor/10thfloor:agent-channel-slack';
import { telegram } from 'meteor/10thfloor:agent-channel-telegram';
import { whatsapp } from 'meteor/10thfloor:agent-channel-whatsapp';
import { sms } from 'meteor/10thfloor:agent-channel-sms';
import { email } from 'meteor/10thfloor:agent-channel-email';

declare const provider: Provider;
declare const sessionId: string;
declare const publicSession: AgentSession;

const config: AgentConfig = { model: 'example', instructions: 'Be useful.', provider };
const support = new Agent('support', config);
const browserAgent = new ClientAgent('support');
const erasure: Promise<SessionErasure> = support.erase(sessionId, { userId: null });
const lookup = tool({
  name: 'lookup', description: 'Look something up',
  args: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } as const,
  run: async ({ query }) => ({ query }),
});
const slackOptions: SlackChannelOptions = {
  agent: 'support', botToken: 'placeholder', signingSecret: 'placeholder',
};
const deliveryOptions: DeliverOnceOptions = {};

void support;
void lookup;
void browserAgent;
void erasure;
void deliveryOptions;
// @ts-expect-error Transcript reservations are private implementation state.
void NAMES.messageReservations;
// @ts-expect-error Durable Activation links are not part of the public Session contract.
void publicSession.pendingInputs;
void slack(slackOptions);
void telegram;
void whatsapp;
void sms;
void email;
