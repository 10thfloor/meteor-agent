import { assert } from "chai";
import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import { Random } from "meteor/random";
import {
  DURABLE_DEFINITION,
  DURABLE_PLAN_KIND,
  messageText,
  splitModelId,
  threadSpend,
  threadTokens,
  titleFromInput,
  transcriptRows,
} from "../imports/constellation/durable.js";

// Threads: Constellation's surface on 10thfloor:durable. The model here is the
// scripted one (CONSTELLATION_OFFLINE=1), which answers from the transcript
// alone and uses the thread's tools, so nothing leaves the process.

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const rejection = (work) => work.then(() => undefined, (error) => error);

describe("Threads: shared helpers", function () {
  it("splits a catalog model ID at its first slash only", function () {
    assert.deepEqual(splitModelId("anthropic/claude-haiku-4-5"), { provider: "anthropic", modelId: "claude-haiku-4-5" });
    assert.deepEqual(splitModelId("openrouter/anthropic/claude-haiku-4.5"), {
      provider: "openrouter", modelId: "anthropic/claude-haiku-4.5",
    });
    assert.deepEqual(splitModelId("constellation/scripted"), { provider: "constellation", modelId: "scripted" });
    for (const bad of ["scripted", "/x", "x/", ""]) assert.throws(() => splitModelId(bad), /Not a model ID/);
  });

  it("adds up what a usage record cost and how many tokens went each way", function () {
    const usage = {
      models: {
        "anthropic/a": { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.25 } },
        "openai/b": { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
      },
      tools: { search: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.125 } } },
    };
    assert.strictEqual(threadSpend(usage), 0.875);
    assert.deepEqual(threadTokens(usage), { input: 146, output: 23 });
    assert.strictEqual(threadSpend(undefined), 0);
    assert.strictEqual(threadSpend({ models: { x: { cost: { total: "many" } } } }), 0);
    assert.deepEqual(threadTokens({}), { input: 0, output: 0 });
  });

  it("names a thread after the first thing said in it", function () {
    assert.strictEqual(titleFromInput("  Why did\nthe deploy   fail? "), "Why did the deploy fail?");
    assert.strictEqual(titleFromInput(""), "New thread");
    const long = titleFromInput("Summarize the incident review and list every action item with its owner and date");
    assert.isAtMost(long.length, 61);
    assert.match(long, /…$/);
    assert.notMatch(long, /\s…$/);
  });

  it("turns Pi Durable's entries into the rows a transcript shows", function () {
    const entries = [
      { id: 2, kind: "pi.user", model: [{ role: "user", content: "old question" }] },
      { id: 4, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old answer" }] }] },
      { id: 6, kind: "pi.reset", head: 6, model: [{ role: "user", content: "carry this over" }] },
      { id: 8, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "plan: a, b" }] }] },
      { id: 9, kind: "pi.system", model: [{ role: "system", content: "" }] },
      {
        id: 10,
        kind: "pi.assistant",
        model: [{
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-1", name: "update_plan", arguments: { items: [] } }],
        }],
      },
      {
        id: 12,
        kind: "pi.tool-result",
        model: [{ role: "toolResult", toolCallId: "call-1", toolName: "update_plan", isError: false, content: [{ type: "text", text: "Plan saved" }] }],
      },
      { id: 14, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Half an" }] }] },
      { id: 16, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded", content: [] }] },
    ];
    const rows = transcriptRows(entries);
    assert.deepEqual(rows.map((row) => `${row.kind}${row.past ? " (past)" : ""}`), [
      "user (past)", "assistant (past)", "marker", "user", "call", "result", "assistant", "assistant",
    ]);
    assert.deepInclude(rows[2], { text: "New context", detail: "carry this over" });
    assert.deepEqual(rows[4].call, { id: "call-1", name: "update_plan", arguments: { items: [] } });
    assert.deepInclude(rows[5], { callId: "call-1", name: "update_plan", text: "Plan saved", failed: false });
    assert.deepInclude(rows[6], { text: "Half an", note: "Cut short" });
    assert.deepInclude(rows[7], { text: "", note: "overloaded" });
    assert.strictEqual(messageText({ role: "system", content: "hidden" }), "");
  });
});

if (Meteor.isServer) {
  describe("Threads: the server", function () {
    this.timeout(60_000);

    let server;
    let durable;
    const owner = `threads-owner-${Random.id()}`;
    const stranger = `threads-stranger-${Random.id()}`;
    const made = [];
    let isOwner;
    let limit;

    const call = (userId, name, ...args) =>
      Meteor.server.method_handlers[name].apply({ userId, unblock() {} }, args);
    const say = (userId, threadId, text, extra = {}) => call(userId, "constellation.durableThreadSay", {
      threadId, conversationId: 1, text, requestId: Random.id(), ...extra,
    });
    const newThread = async (title) => {
      const created = await call(owner, "constellation.durableThreadCreate", title);
      made.push(created.threadId);
      return created;
    };
    const rowsOf = async (threadId, conversationId = 1) => {
      const reader = await server.Threads.reader(threadId);
      const { BACKGROUND_CONTEXT } = await durable.loadChord("context");
      const page = await reader.scanEntries({ conversationId }, 200, undefined, BACKGROUND_CONTEXT);
      return transcriptRows([...page.items].reverse());
    };
    const settled = (threadId, submissionId) => server.Threads.settled(threadId, submissionId, { timeoutMs: 15_000 });
    /** A conversation's plan as a viewer is published it: the rows of the document's present value, applied in order. */
    const planOf = async (threadId, conversationId = 1) => {
      const revisions = await durable.DurableRevisions.find(
        { s: `${DURABLE_DEFINITION}/${threadId}`, o: conversationId, cur: true, k: JSON.stringify(DURABLE_PLAN_KIND) },
        { sort: { q: 1 } },
      ).fetchAsync();
      if (revisions.length === 0) return undefined;
      assert.strictEqual(revisions[0].t, "base");
      const { applyImmutable } = await durable.loadChord("delta");
      return revisions.slice(1).reduce(
        (value, revision) => applyImmutable(value, JSON.parse(revision.c)), JSON.parse(revisions[0].c),
      ).items;
    };

    before(async function () {
      server = await import("../server/constellation-durable.js");
      durable = await import("meteor/10thfloor:durable");
      isOwner = server.access.isOwner;
      // There is one workspace in a test run, and it is the browser's to claim. Stand an owner in beside it.
      server.access.isOwner = async (userId) => userId === owner || isOwner(userId);
      limit = process.env.CONSTELLATION_DURABLE_SPEND_LIMIT;
    });

    after(async function () {
      for (const threadId of made.splice(0)) {
        await rejection(call(owner, "constellation.durableThreadRemove", threadId));
      }
      server.access.isOwner = isOwner;
      if (limit === undefined) delete process.env.CONSTELLATION_DURABLE_SPEND_LIMIT;
      else process.env.CONSTELLATION_DURABLE_SPEND_LIMIT = limit;
    });

    it("makes a thread, answers in it, and names it after what was said", async function () {
      const { threadId, conversationId } = await newThread();
      assert.strictEqual(conversationId, 1);
      const row = await server.DurableThreads.findOneAsync(threadId);
      assert.deepInclude(row, { userId: owner, title: "New thread", model: "default" });
      assert.deepEqual(row.conversations.map((conversation) => conversation.id), [1]);

      const { submissionId } = await say(owner, threadId, "Hello there");
      assert.strictEqual((await settled(threadId, submissionId)).status, "done");
      const rows = await rowsOf(threadId);
      assert.deepEqual(rows.map((entry) => entry.kind), ["user", "assistant"]);
      assert.include(rows[1].text, 'You said: "Hello there"');
      assert.strictEqual((await server.DurableThreads.findOneAsync(threadId)).title, "Hello there");

      // A title a person gave is kept.
      await call(owner, "constellation.durableThreadRename", threadId, "  Greetings ");
      await settled(threadId, (await say(owner, threadId, "Another thing")).submissionId);
      assert.strictEqual((await server.DurableThreads.findOneAsync(threadId)).title, "Greetings");
    });

    it("admits a retried input once", async function () {
      const { threadId } = await newThread("Retries");
      const requestId = Random.id();
      const first = await say(owner, threadId, "only once", { requestId });
      const again = await say(owner, threadId, "only once", { requestId });
      assert.strictEqual(again.submissionId, first.submissionId);
      await settled(threadId, first.submissionId);
      assert.lengthOf((await rowsOf(threadId)).filter((row) => row.kind === "user"), 1);
    });

    it("lets the agent keep a plan, which is a document of the conversation", async function () {
      const { threadId } = await newThread("Planning");
      const { submissionId } = await say(owner, threadId, "plan: draft the brief, review it, ship");
      assert.strictEqual((await settled(threadId, submissionId)).status, "done");
      const rows = await rowsOf(threadId);
      assert.deepEqual(rows.map((row) => row.kind), ["user", "call", "result", "assistant"]);
      assert.strictEqual(rows[1].call.name, "update_plan");
      assert.strictEqual(rows[2].text, "Plan saved: 3 items, 0 done.");
      assert.strictEqual(rows[3].text, "Done. Plan saved: 3 items, 0 done.");

      // What a viewer is published: the plan's present value, as rows of the storage.
      assert.deepEqual(await planOf(threadId), [
        { text: "draft the brief", status: "pending" },
        { text: "review it", status: "pending" },
        { text: "ship", status: "pending" },
      ]);
    });

    it("forks a conversation, and the fork goes on from the plan as it was there", async function () {
      const { threadId } = await newThread("Forking");
      await settled(threadId, (await say(owner, threadId, "plan: one, two")).submissionId);
      const rows = await rowsOf(threadId);
      const at = rows[rows.length - 1].id;
      // The parent moves on, and changes its plan, after the point the fork is made from.
      await settled(threadId, (await say(owner, threadId, "plan: three")).submissionId);
      assert.deepEqual((await planOf(threadId)).map((item) => item.text), ["three"]);

      const { conversationId: fork } = await call(owner, "constellation.durableThreadFork", threadId, 1, at);
      assert.notStrictEqual(fork, 1);
      const row = await server.DurableThreads.findOneAsync(threadId);
      assert.deepInclude(row.conversations[1], { id: fork, parent: 1, at });

      // The fork sees its parent up to the fork point and nothing after: its entries, and its plan.
      const forked = await rowsOf(threadId, fork);
      assert.deepEqual(forked.map((entry) => entry.kind), ["user", "call", "result", "assistant"]);
      assert.deepEqual((await planOf(threadId, fork)).map((item) => item.text), ["one", "two"]);
      const answer = await say(owner, threadId, "in the fork", { conversationId: fork });
      assert.strictEqual((await settled(threadId, answer.submissionId)).status, "done");
      assert.include((await rowsOf(threadId, fork)).pop().text, 'You said: "in the fork"');
      assert.notInclude((await rowsOf(threadId)).map((entry) => entry.text).join("\n"), "in the fork");

      // A conversation the thread does not have is not the caller's to speak in or fork.
      for (const refused of [
        say(owner, threadId, "nowhere", { conversationId: 999 }),
        call(owner, "constellation.durableThreadFork", threadId, 999, at),
      ]) assert.strictEqual((await rejection(refused))?.error, "no-conversation");
    });

    it("runs on the workspace default, and takes only a model the catalog offers", async function () {
      const { threadId } = await newThread("Models");
      const catalog = await (await import("../server/main.js")).modelCatalogView(owner);
      // Offline, the catalog is the scripted model alone.
      assert.strictEqual(catalog.defaultModel, "constellation/scripted");
      await call(owner, "constellation.durableThreadModel", threadId, "constellation/scripted");
      assert.strictEqual((await server.DurableThreads.findOneAsync(threadId)).model, "constellation/scripted");
      const refused = await rejection(call(owner, "constellation.durableThreadModel", threadId, "anthropic/claude-haiku-4-5"));
      assert.strictEqual(refused?.error, "model-unavailable");
      // The thread still answers.
      assert.strictEqual((await settled(threadId, (await say(owner, threadId, "still here")).submissionId)).status, "done");
    });

    it("is the owner's alone", async function () {
      const { threadId } = await newThread("Private");
      for (const userId of [null, stranger]) {
        for (const [name, ...args] of [
          ["constellation.durableThreadCreate"],
          ["constellation.durableThreadRename", threadId, "Mine now"],
          ["constellation.durableThreadSay", { threadId, conversationId: 1, text: "hi", requestId: Random.id() }],
          ["constellation.durableThreadFork", threadId, 1, 2],
          ["constellation.durableThreadModel", threadId, "default"],
          ["constellation.durableThreadRemove", threadId],
        ]) {
          const refused = await rejection(call(userId, name, ...args));
          assert.strictEqual(refused?.error, "not-authorized", `${name} as ${userId}`);
        }
      }
      // Speaking, creating and forking go through the app. The package's own methods take none of them from a
      // browser, whoever asks; they do take the rest from the thread's owner.
      const target = { host: DURABLE_DEFINITION, key: threadId, conversationId: 1 };
      for (const [name, params] of [
        [durable.NAMES.mSubmit, { ...target, content: "around the app" }],
        [durable.NAMES.mRoot, { host: DURABLE_DEFINITION, key: threadId }],
        [durable.NAMES.mCreate, { host: DURABLE_DEFINITION, key: threadId }],
        [durable.NAMES.mFork, { ...target, at: 2 }],
      ]) {
        assert.strictEqual((await rejection(call(owner, name, params)))?.error, "not-authorized", name);
      }
      assert.strictEqual((await rejection(call(stranger, durable.NAMES.mAbort, target)))?.error, "not-authorized");
      assert.deepEqual(await call(owner, durable.NAMES.mAbort, target), { idle: true });
      assert.lengthOf(await rowsOf(threadId), 0);

      // Input is bounded before anything is opened.
      for (const params of [
        { threadId, conversationId: 1, text: "   ", requestId: Random.id() },
        { threadId, conversationId: 1, text: "x".repeat(20_001), requestId: Random.id() },
        { threadId, conversationId: 1, text: "x", requestId: "short" },
        { threadId, conversationId: 1, text: "x", requestId: Random.id(), whenBusy: "reject" },
        { threadId, conversationId: 0, text: "x", requestId: Random.id() },
      ]) {
        const refused = await rejection(call(owner, "constellation.durableThreadSay", params));
        assert.strictEqual(refused?.errorType, "Match.Error", JSON.stringify(params).slice(0, 80));
      }
    });

    it("stops taking input, and ends a tool round, once a thread has spent its limit", async function () {
      const { threadId } = await newThread("Budget");
      await settled(threadId, (await say(owner, threadId, "within the limit")).submissionId);

      process.env.CONSTELLATION_DURABLE_SPEND_LIMIT = "0";
      try {
        assert.strictEqual(server.spendLimit(), 0);
        const refused = await rejection(say(owner, threadId, "one more"));
        assert.strictEqual(refused?.error, "spend-limit");
        assert.include(refused.reason, "$0.00");

        // Past the method, as a run already under way is: its tool round is the last thing it does.
        const { submissionId } = await server.Threads.submit(threadId, 1, "wait 0");
        await settled(threadId, submissionId);
        const rows = await rowsOf(threadId);
        assert.deepEqual(rows.slice(-3).map((row) => row.kind), ["user", "call", "result"]);
        assert.include(rows[rows.length - 1].text, "Waited 0 seconds.");
        assert.include(rows[rows.length - 1].text, "Stopped: this thread reached its spending limit of $0.00.");
      } finally {
        delete process.env.CONSTELLATION_DURABLE_SPEND_LIMIT;
      }
      // With the limit back, the thread goes on.
      assert.strictEqual((await settled(threadId, (await say(owner, threadId, "and again")).submissionId)).status, "done");
    });

    it("deletes a thread with everything in it", async function () {
      const { threadId } = await newThread("Short-lived");
      await settled(threadId, (await say(owner, threadId, "forget me")).submissionId);
      const storage = `${DURABLE_DEFINITION}/${threadId}`;
      assert.isAbove(await durable.DurableEntries.find({ s: storage }).countAsync(), 0);
      await call(owner, "constellation.durableThreadRemove", threadId);
      assert.isUndefined(await server.DurableThreads.findOneAsync(threadId));
      assert.strictEqual(await durable.DurableEntries.find({ s: storage }).countAsync(), 0);
      assert.strictEqual(await durable.DurableRevisions.find({ s: storage }).countAsync(), 0);
      assert.strictEqual((await rejection(say(owner, threadId, "anyone?")))?.error, "no-thread");
    });

    it("publishes a person their own threads, and nobody else's", async function () {
      const { threadId } = await newThread("Listed");
      const publish = Meteor.server.publish_handlers["constellation.durableThreads"];
      const mine = await publish.call({ userId: owner, ready() {} }).fetchAsync();
      assert.include(mine.map((thread) => thread._id), threadId);
      assert.hasAllKeys(mine[0], ["_id", "title", "model", "conversations", "createdAt", "updatedAt"]);
      assert.lengthOf(await publish.call({ userId: stranger, ready() {} }).fetchAsync(), 0);
      let ready = false;
      assert.isUndefined(publish.call({ userId: null, ready() { ready = true; } }));
      assert.isTrue(ready);
    });
  });
}

if (Meteor.isClient) {
  // The real page, the real connection, the scripted model. Everything is done
  // the way a person does it: through the layer's own controls.
  describe("Threads: the layer", function () {
    this.timeout(60_000);

    const $ = (id) => document.getElementById(id);
    const shell = () => $("workspace-shell");
    const visible = (node) => !!node && !node.hidden && node.offsetParent !== null;
    const rows = (selector) => [...$("threads-transcript").querySelectorAll(selector)];
    const plan = () => [...$("threads-plan").querySelectorAll("li:not(.threads-plan-empty)")].map((item) => item.textContent);
    const threadCount = () => Number($("threads-count").textContent);

    async function say(text) {
      const input = $("threads-input");
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      $("threads-composer").requestSubmit();
      await until(() => {
        // A refusal is said in the composer; it is the reason, and the test should end with it.
        const status = $("threads-status");
        if (status.dataset.kind === "error" && status.textContent) throw new Error(`refused: ${status.textContent}`);
        return input.value === "";
      }, `"${text}" to be taken`);
    }
    const idle = () => until(() => $("threads-stop").hidden && $("threads-send").textContent === "Send", "the run to end");

    before(async function () {
      // The button appears once the workspace has started; before that the app is still choosing its own view.
      await until(() => $("app-frame")?.dataset.startupState === "ready" && visible($("threads-rail")), "the workspace to start", 30_000);
    });

    after(async function () {
      // Leave the page as the other suites expect it: no layer, no threads.
      if (!$("threads-layer").hidden) $("threads-rail").click();
      const threads = Mongo.getCollection("constellation_durable_threads");
      const subscription = Meteor.subscribe("constellation.durableThreads");
      await until(() => subscription.ready(), "the thread list");
      for (const thread of threads.find().fetch()) {
        await rejection(Meteor.callAsync("constellation.durableThreadRemove", thread._id));
      }
      subscription.stop();
    });

    it("opens over the workspace from the rail, and choosing any view closes it", async function () {
      const rail = $("threads-rail");
      const layer = $("threads-layer");
      const stage = document.querySelector(".content-stage");
      const before = shell().dataset.currentView;
      const current = document.querySelector(`.rail-button[data-view="${before}"]`);
      assert.isTrue(layer.hidden);
      assert.strictEqual(current.getAttribute("aria-current"), "page");

      rail.click();
      assert.isFalse(layer.hidden);
      assert.strictEqual(rail.getAttribute("aria-pressed"), "true");
      assert.strictEqual(rail.getAttribute("aria-current"), "page");
      assert.isNull(current.getAttribute("aria-current"));
      // What is underneath cannot take focus, and the app's own idea of its view has not changed.
      assert.isTrue(stage.inert);
      assert.strictEqual(shell().dataset.currentView, before);

      // Closed by its own button: everything is as it was.
      rail.click();
      assert.isTrue(layer.hidden);
      assert.isFalse(stage.inert);
      assert.strictEqual(current.getAttribute("aria-current"), "page");
      assert.isNull(rail.getAttribute("aria-current"));

      // Closed by a view being chosen: that view is in front.
      rail.click();
      document.querySelector('.rail-button[data-view="memory"]').click();
      await until(() => layer.hidden, "the layer to close");
      assert.strictEqual(shell().dataset.currentView, "memory");
      assert.isFalse(stage.inert);
      assert.strictEqual(document.querySelector('.rail-button[data-view="memory"]').getAttribute("aria-current"), "page");
      assert.strictEqual(rail.getAttribute("aria-pressed"), "false");
      document.querySelector(`.rail-button[data-view="${before}"]`).click();
    });

    it("makes a thread, shows the agent's tool call and plan, and names the thread after what was said", async function () {
      $("threads-rail").click();
      await until(() => visible($("threads-start")) || visible($("threads-new")), "the layer");
      const count = threadCount();
      $("threads-new").click();
      await until(() => threadCount() === count + 1 && visible($("threads-input")), "the new thread");
      assert.strictEqual($("threads-title").textContent, "New thread");
      assert.deepEqual(plan(), []);

      await say("plan: draft the brief, review it, ship");
      await until(() => plan().length === 3, "the plan");
      await idle();
      assert.deepEqual(plan(), ["draft the brief", "review it", "ship"]);
      assert.deepEqual(rows(".threads-user").map((row) => row.textContent), ["plan: draft the brief, review it, ship"]);
      const [card] = rows(".threads-tool");
      assert.strictEqual(card.querySelector("strong").textContent, "update_plan");
      assert.strictEqual(card.dataset.status, "done");
      assert.strictEqual(card.querySelector("pre").textContent, "Plan saved: 3 items, 0 done.");
      assert.strictEqual(rows(".threads-assistant .threads-message-body").pop().textContent, "Done. Plan saved: 3 items, 0 done.");
      await until(() => $("threads-title").textContent === "plan: draft the brief, review it, ship", "the title");
      assert.match($("threads-usage").textContent, /^\$0\.00 · [\d.k]+ in · [\d.k]+ out$/);
      assert.strictEqual(document.activeElement, $("threads-input"));
    });

    it("queues what is said while a tool runs, lets it be withdrawn, and stops the work", async function () {
      await say("wait 20");
      await until(() => !$("threads-stop").hidden && rows('.threads-tool[data-status="running"]').length === 1, "the tool to run");
      assert.strictEqual($("threads-send").textContent, "Queue");
      await until(() => /\ds/.test(rows('.threads-tool[data-status="running"] pre')[0]?.textContent ?? ""), "the tool's output");

      await say("and one more thing");
      await until(() => !$("threads-queue-section").hidden, "the queue");
      const [queued] = [...$("threads-queue").children];
      assert.include(queued.textContent, "and one more thing");
      assert.include(queued.textContent, "After this answer");
      queued.querySelector(".threads-withdraw").click();
      await until(() => $("threads-queue-section").hidden, "the withdrawal");

      $("threads-stop").click();
      await idle();
      // The withdrawn input never reached the transcript.
      assert.notInclude(rows(".threads-user").map((row) => row.textContent), "and one more thing");
      // And the thread is usable afterwards.
      await say("still there?");
      await until(() => rows(".threads-assistant .threads-message-body").some((row) => row.textContent.includes('You said: "still there?"')), "the next answer");
      await idle();
    });

    it("forks from an answer, and each branch keeps its own plan", async function () {
      const fork = rows(".threads-assistant .threads-fork")[0];
      assert.strictEqual(fork.textContent, "Fork from here");
      fork.click();
      await until(() => $("threads-branch").value !== "1" && visible($("threads-branch")), "the fork");
      await until(() => rows(".threads-user").length === 1, "the fork's history");
      // The fork sees its parent up to the fork point, with the plan as it was there.
      assert.deepEqual(rows(".threads-user").map((row) => row.textContent), ["plan: draft the brief, review it, ship"]);
      assert.deepEqual(plan(), ["draft the brief", "review it", "ship"]);
      assert.deepEqual([...$("threads-branch").options].map((option) => option.textContent), ["Main", "Fork 1"]);

      await say("plan: another way");
      await until(() => plan().length === 1, "the fork's plan");
      await idle();
      assert.deepEqual(plan(), ["another way"]);

      const branch = $("threads-branch");
      branch.value = "1";
      branch.dispatchEvent(new Event("change", { bubbles: true }));
      await until(() => plan().length === 3, "the main branch's plan");
      assert.isAtLeast(rows(".threads-user").length, 3);
    });

    it("renders an answer's Markdown as inert DOM", async function () {
      const { renderMarkdown, safeLink } = await import("../client/durable-markdown.js");
      const target = document.createElement("div");
      renderMarkdown(target, [
        "## Findings",
        "",
        "Some **bold** text, `code`, and a [link](https://example.com/a?b=1).",
        "",
        "<script>window.__threadsPwned = true</script>",
        '<img src="x" onerror="window.__threadsPwned = true">',
        "",
        "[bad](javascript:window.__threadsPwned=true) and ![pixel](https://example.com/p.png)",
        "",
        "- [x] done",
        "- [ ] open",
        "",
        "```js",
        "const x = '<b>not markup</b>';",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n"));
      assert.isUndefined(window.__threadsPwned);
      assert.lengthOf(target.querySelectorAll("script, img, iframe, [onerror]"), 0);
      assert.strictEqual(target.querySelector('[role="heading"]').textContent, "Findings");
      assert.strictEqual(target.querySelector("strong").textContent, "bold");
      const links = [...target.querySelectorAll("a")];
      assert.lengthOf(links, 1);
      assert.strictEqual(links[0].href, "https://example.com/a?b=1");
      assert.strictEqual(links[0].rel, "noopener noreferrer");
      assert.include(target.textContent, "<script>window.__threadsPwned = true</script>");
      assert.include(target.textContent, "bad");
      assert.strictEqual(target.querySelector("pre code").textContent, "const x = '<b>not markup</b>';");
      assert.deepEqual([...target.querySelectorAll("li")].map((item) => item.dataset.task), ["done", "open"]);
      assert.deepEqual([...target.querySelectorAll("td")].map((cell) => cell.textContent), ["1", "2"]);

      assert.strictEqual(safeLink("https://example.com/"), "https://example.com/");
      assert.strictEqual(safeLink("mailto:a@example.com"), "mailto:a@example.com");
      for (const bad of ["javascript:alert(1)", "http://example.com/", "//example.com", "data:text/html,x", "https://user:pw@example.com/", " "]) {
        assert.isNull(safeLink(bad), bad);
      }
      // An answer still arriving, cut off in the middle of its Markdown, is text too.
      renderMarkdown(target, "Half a **bold and a [link](https://exam");
      assert.include(target.textContent, "Half a");
    });

    it("renames a thread, and deletes it on the second press", async function () {
      $("threads-title").click();
      const input = $("threads-title-input");
      assert.isFalse(input.hidden);
      input.value = "A better name";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => $("threads-list").querySelector(".current strong")?.textContent === "A better name", "the new title");

      const count = threadCount();
      const button = $("threads-delete");
      button.click();
      assert.strictEqual(button.textContent, "Delete for good?");
      assert.strictEqual(threadCount(), count);
      button.click();
      await until(() => threadCount() === count - 1, "the thread to go");
      await until(() => button.textContent === "Delete", "the button to rest");
    });
  });
}
