import { Meteor } from 'meteor/meteor';
import { defineAgentChat } from 'meteor/10thfloor:agent';

// The demo is now the packaged element's first consumer: one tag in main.html,
// one `defineAgentChat()` here, and the whole chat — streaming bubbles, tool
// rows, phases, the approval bar, the composer — comes from the package.
//
// The PRE-ELEMENT version of this file is the "no framework needed" reference:
// ~70 lines of plain DOM over a reactive cursor, which is exactly what
// `client/element.ts` packages. It lives in git history —
// `git show ad0dc0b:app/client/main.js` — and is worth reading before deciding
// you need React to render an agent.

const SESSION_KEY = 'agent-demo-session';

Meteor.startup(() => {
  const chat = document.querySelector('agent-chat');

  // Set the attribute BEFORE defining the tag. Registration upgrades the
  // element immediately, and an upgrade with no `session-id` auto-starts a
  // fresh session — so defining first would burn a new session on every
  // reload and then re-subscribe to the saved one a tick later.
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) chat.setAttribute('session-id', saved);

  // The element only emits this when it started the session itself, which is
  // exactly when the host has something new to remember.
  chat.addEventListener('agent-chat:session', (e) => {
    localStorage.setItem(SESSION_KEY, e.detail.sessionId);
  });

  // Self-healing across a wiped database: if the server no longer knows the
  // saved session, the first send fails and we drop the id so the next reload
  // starts clean.
  chat.addEventListener('agent-chat:error', () => {
    localStorage.removeItem(SESSION_KEY);
  });

  defineAgentChat();
});
