import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import { Accounts } from 'meteor/accounts-base';
import { Agent, defineAgentChat } from 'meteor/10thfloor:agent';

// The demo is the packaged element's first consumer: the chat itself — bubbles,
// tool rows, phases, the approval bar — is one <agent-chat> tag. What THIS file
// adds is the multi-surface story around it: an account (accounts-password), the
// user's conversation list (the `agent.sessions` publication — which now
// includes conversations that STARTED IN SLACK, badged by origin), and the
// channel-linking hand-off (DM the bot the word "link", open the URL it
// answers with, and the Slack conversation becomes this account's).
//
// Everything is plain DOM over reactive cursors — no framework, same as the
// pre-element demo (`git show ad0dc0b:app/client/main.js`).

const SESSION_KEY = 'agent-demo-session';
const demo = new Agent('demo');

const $ = (id) => document.getElementById(id);

Meteor.startup(() => {
  const chat = document.querySelector('agent-chat');

  // ---- The chat element: attach BEFORE defining the tag --------------------
  // Registration upgrades the element immediately, and an upgrade with no
  // `session-id` auto-starts a fresh session — so defining first would burn a
  // session on every reload and re-subscribe to the saved one a tick later.
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) chat.setAttribute('session-id', saved);

  chat.addEventListener('agent-chat:session', (e) => {
    localStorage.setItem(SESSION_KEY, e.detail.sessionId);
  });
  // Self-healing on `no-session` ONLY — see the pre-element demo's history for
  // why not on every error. It also covers the login/logout seam: an
  // anonymous session doesn't belong to the account you just became, the next
  // send is refused, and we fall back to a clean start.
  chat.addEventListener('agent-chat:error', (e) => {
    if (e.detail?.error?.error !== 'no-session') return;
    localStorage.removeItem(SESSION_KEY);
  });

  defineAgentChat();

  const openSession = (sessionId) => {
    localStorage.setItem(SESSION_KEY, sessionId);
    chat.setAttribute('session-id', sessionId);
  };

  const startFresh = () => {
    demo.start().then(openSession).catch((err) => {
      console.error('[demo] could not start a conversation:', err);
    });
  };

  $('new-chat').addEventListener('click', startFresh);

  // ---- The account box -----------------------------------------------------
  // Rebuilt from scratch on every auth change. All user-supplied strings go
  // through textContent — the same rule the element holds for transcripts.
  const accountBox = $('account-box');

  function renderSignedOut() {
    accountBox.textContent = '';
    const form = document.createElement('form');
    const user = document.createElement('input');
    user.placeholder = 'username';
    user.autocomplete = 'username';
    const pass = document.createElement('input');
    pass.type = 'password';
    pass.placeholder = 'password';
    pass.autocomplete = 'current-password';
    const row = document.createElement('div');
    row.className = 'account-actions';
    const signIn = document.createElement('button');
    signIn.type = 'submit';
    signIn.textContent = 'Sign in';
    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = 'Create account';
    const note = document.createElement('p');
    note.className = 'account-note';
    row.append(signIn, create);
    form.append(user, pass, row, note);
    accountBox.append(form);

    const fail = (err) => { note.textContent = err?.reason ?? String(err); };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      Meteor.loginWithPassword(user.value.trim(), pass.value, (err) => { if (err) fail(err); });
    });
    create.addEventListener('click', () => {
      Accounts.createUser({ username: user.value.trim(), password: pass.value }, (err) => {
        if (err) fail(err);
      });
    });
  }

  function renderSignedIn(username) {
    accountBox.textContent = '';
    const who = document.createElement('p');
    who.className = 'account-who';
    who.textContent = username;
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out';
    out.addEventListener('click', () => Meteor.logout());
    accountBox.append(who, out);
  }

  // ---- The channel-link hand-off ------------------------------------------
  // The bot answers a "link" DM with /link/<token>; landing here with that
  // path arms the redeem, which runs the moment a signed-in user exists —
  // linking always completes from the authenticated side.
  const linkBox = $('link-box');
  let pendingLinkToken = null;
  const linkMatch = window.location.pathname.match(/^\/link\/([A-Za-z0-9_-]+)$/);
  if (linkMatch) {
    pendingLinkToken = linkMatch[1];
    window.history.replaceState({}, '', '/');   // the token is spent below, not bookmarkable
    linkBox.hidden = false;
    linkBox.textContent = 'Linking your Slack conversation — sign in (or create an account) to finish.';
  }

  function redeemPendingLink() {
    if (!pendingLinkToken) return;
    const token = pendingLinkToken;
    pendingLinkToken = null;
    linkBox.hidden = false;
    linkBox.textContent = 'Linking…';
    Meteor.callAsync('demo.linkChannel', token).then((res) => {
      linkBox.textContent = `Linked ${res.kind} identity ${res.externalUserId}. `
        + 'Your Slack conversation now belongs to this account — it is in the list below, '
        + 'and the agent knows who you are on both surfaces.';
    }).catch((err) => {
      linkBox.textContent = err?.reason ?? 'Linking failed.';
    });
  }

  // ---- Auth-driven wiring --------------------------------------------------
  // One autorun owns the seams that depend on who is signed in: the account
  // box, the sessions subscription, and the armed link redeem. `previousUser`
  // distinguishes a page LOAD (leave the saved session alone) from a genuine
  // login/logout TRANSITION (the old session is not this identity's — detach
  // and start clean rather than letting the next send bounce).
  let previousUser;
  Tracker.autorun(() => {
    const userId = Meteor.userId();
    const username = Meteor.user()?.username ?? 'signed in';
    if (userId) {
      renderSignedIn(username);
      demo.subscribeSessions();
      redeemPendingLink();
    } else {
      renderSignedOut();
    }
    if (previousUser !== undefined && previousUser !== userId) {
      localStorage.removeItem(SESSION_KEY);
      startFresh();
    }
    previousUser = userId;
  });

  // ---- The conversation list ----------------------------------------------
  // A reactive render over the `agent.sessions` cursor: newest first, children
  // excluded, at most 100 — all decided by the publication. Rows carry the
  // surface badge (`session.channel.origin`) so a conversation that started in
  // Slack is visibly the same object the web is now reading.
  const list = $('sessions-list');
  const empty = $('sessions-empty');
  Tracker.autorun(() => {
    const signedIn = !!Meteor.userId();
    // Minimongo doesn't inherit the publication's sort — order here.
    const sessions = (signedIn ? demo.sessions().fetch() : [])
      .sort((a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0));
    empty.hidden = signedIn && sessions.length > 0;
    empty.textContent = signedIn
      ? 'No conversations yet — say something, or DM the Slack bot.'
      : 'Sign in to see your conversations across surfaces.';
    list.textContent = '';
    for (const session of sessions) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-row';
      if (session._id === chat.getAttribute('session-id')) button.classList.add('current');
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = session.title ?? `Conversation ${session._id.slice(0, 6)}`;
      const meta = document.createElement('span');
      meta.className = 'session-meta';
      const origin = session.channel?.origin;
      meta.textContent = [
        origin ? `via ${origin}` : 'web',
        session.phase,
        session.updatedAt instanceof Date ? session.updatedAt.toLocaleTimeString() : '',
      ].filter(Boolean).join(' · ');
      button.append(title, meta);
      button.addEventListener('click', () => openSession(session._id));
      item.append(button);
      list.append(item);
    }
  });
});
