import { assert } from "chai";
import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";

if (Meteor.isClient) {
  // The Crew section of the Mission inspector, as the app draws it for the
  // Mission it opens with: the people and the agents on the Mission, set alike
  // in two lists; what waits for review; and under the lists, which crew this
  // is and the two controls that change one.
  describe("Mission crew: the panel", function () {
    this.timeout(60_000);

    const $ = (id) => document.getElementById(id);
    const one = (selector) => document.querySelector(selector);
    const all = (selector) => [...document.querySelectorAll(selector)];
    const box = (element) => element.getBoundingClientRect();
    const drawn = (element) => getComputedStyle(element);
    const until = async (check, what, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const people = () => all("#mission-crew-people .mission-person-row");
    const agents = () => all("#crew-list .crew-card");
    // The Crew section is the first of the tab's three; Mission health and Channels follow it.
    const CREW = "#inspector-panel-crew > .inspector-section:first-child";
    const heading = () => one(`${CREW} > .section-heading > span`);
    const hint = () => $("crew-mode-hint").textContent;
    const FOLLOWS = "Follows the workspace roster";
    const CLEAR = "rgba(0, 0, 0, 0)";

    // The page eases a card into a new state and the inspector into a new
    // width; a test wants where they end up. Whatever `change` sets on the
    // element is put back, with the easing.
    const settled = (element, change) => {
      const before = { transition: element.style.transition, state: element.dataset.agentState, width: element.style.width };
      element.style.transition = "none";
      try {
        return change(element);
      } finally {
        if (before.state === undefined) delete element.dataset.agentState;
        else element.dataset.agentState = before.state;
        element.style.width = before.width;
        element.style.transition = before.transition;
      }
    };
    // The inspector at the width it has in a narrow window.
    const narrow = (look) => settled($("inspector-pane"), (pane) => {
      pane.style.width = "285px";
      return look();
    });
    const uncut = (element) => element.scrollWidth <= element.clientWidth;

    before(async function () {
      await until(() => $("app-frame")?.dataset.startupState === "ready", "the workspace to start", 30_000);
      // The section is on the Missions view's Crew tab, which is where the app starts.
      await until(() => people().length > 0 && agents().length > 1 && hint(), "the crew to be drawn");
    });

    it("sets a person and an agent alike: one size of name, of line and of avatar", function () {
      const [person] = people();
      const [agent] = agents();
      const name = [person.querySelector(".mission-person-copy strong"), agent.querySelector(".crew-copy strong")];
      const line = [person.querySelector(".mission-person-copy span"), agent.querySelector(".crew-copy span")];
      const avatar = [person.querySelector(".participant-avatar"), agent.querySelector(".crew-avatar")];
      const same = (pair, read) => assert.strictEqual(read(pair[0]), read(pair[1]));
      same(name, (element) => drawn(element).fontSize);
      same(line, (element) => drawn(element).fontSize);
      same(line, (element) => drawn(element).color);
      same(avatar, (element) => drawn(element).fontSize);
      same(avatar, (element) => drawn(element).borderTopWidth);
      // Sizes to read at, not the 10 and 9 pixels an agent's two lines were held to.
      assert.isAtLeast(parseFloat(drawn(name[1]).fontSize), 13);
      assert.isAtLeast(parseFloat(drawn(line[1]).fontSize), 12);
      for (const side of ["width", "height", "left"]) {
        assert.closeTo(box(avatar[0])[side], box(avatar[1])[side], 0.5, `avatar ${side}`);
      }
      assert.closeTo(box(name[0]).left, box(name[1]).left, 0.5, "where a name starts");
      assert.closeTo(box(person).height, box(agent).height, 0.5, "the height of a row");
    });

    it("stands on the edges the other sections keep", function () {
      const left = box(heading()).left;
      const right = box($("open-learning-reviews")).right;
      for (const selector of [
        ".crew-subsection-heading", "#mission-crew-people .participant-avatar", "#crew-list .crew-avatar",
        "#crew-mode-hint", ".crew-actions", ".mission-health .section-heading", ".health-meter",
      ]) assert.closeTo(box(one(selector)).left, left, 0.5, `left of ${selector}`);
      for (const selector of ["#mission-crew-people-count", "#crew-count", ".crew-actions", ".health-meter"]) {
        assert.closeTo(box(one(selector)).right, right, 0.5, `right of ${selector}`);
      }
      // A title stands the same distance under its section's rule, with a button beside it or without.
      const under = (section) => box(section.querySelector(".section-heading > span")).top - box(section).top;
      const [crew, health] = all("#inspector-panel-crew > .inspector-section");
      assert.closeTo(under(crew), under(health), 0.5);
    });

    it("says who the owner is in the row's own line, not in a badge beside it", function () {
      const owner = people().find((row) => row.dataset.role === "owner");
      assert.ok(owner, "the owner's row");
      assert.deepEqual([...owner.children].map((child) => child.className), ["participant-avatar human", "mission-person-copy"]);
      assert.strictEqual(owner.querySelector(".mission-person-copy span").textContent, "Owner · Desktop");
    });

    it("counts the crew beside its heading, and never cuts the heading short", function () {
      assert.strictEqual($("mission-crew-count").textContent, String(people().length + agents().length));
      assert.strictEqual(heading().textContent, `CREW ${$("mission-crew-count").textContent}`);
      assert.strictEqual($("mission-crew-people-count").textContent, String(people().length));
      assert.strictEqual($("crew-count").textContent, String(agents().length));
      assert.isTrue(uncut(heading()));
      assert.isTrue(narrow(() => uncut(heading())), "in a narrow window");
    });

    it("shows a count on Reviews only while something waits for review", async function () {
      const reviews = $("open-learning-reviews");
      const count = $("mission-reviews-count");
      // Nothing has been learned in a workspace this new.
      await until(() => reviews.getAttribute("aria-label").includes("0 items need attention"), "the reviews to be counted");
      assert.strictEqual(reviews.dataset.pending, "false");
      assert.strictEqual(drawn(count).display, "none");
      const quiet = { width: box(reviews).width, border: drawn(reviews).borderTopColor };

      // What the server would publish for a practice an agent has proposed, put where the page reads it.
      const practices = Mongo.getCollection("agent_practices");
      const proposed = practices._collection.insert({
        status: "candidate", key: "say-what-changed", agentId: "constellation-agent-orchestrator",
        createdAt: new Date(), updatedAt: new Date(),
      });
      try {
        await until(() => reviews.dataset.pending === "true", "Reviews to say something waits");
        assert.strictEqual(count.textContent, "1");
        assert.include(reviews.getAttribute("aria-label"), "1 item needs attention");
        assert.notStrictEqual(drawn(count).display, "none");
        assert.notStrictEqual(drawn(count).color, drawn(reviews).color, "the count is lit");
        assert.notStrictEqual(drawn(reviews).borderTopColor, quiet.border);
        assert.isAbove(box(reviews).width, quiet.width);
        assert.isTrue(narrow(() => uncut(heading())), "the heading keeps its room in a narrow window");
      } finally {
        practices._collection.remove(proposed);
      }
      await until(() => reviews.dataset.pending === "false", "Reviews to go quiet again");
      assert.strictEqual(drawn(count).display, "none");
      assert.closeTo(box(reviews).width, quiet.width, 0.5);
    });

    it("shows a state dot only on an agent with something to report", function () {
      const [card] = agents();
      assert.strictEqual(card.dataset.agentState, "ready");
      const dot = card.querySelector(".crew-avatar i");
      assert.strictEqual(drawn(dot).display, "none");
      settled(card, () => {
        for (const state of ["thinking", "loading", "working", "waiting", "retrying", "error", "stopped"]) {
          card.dataset.agentState = state;
          assert.notStrictEqual(drawn(dot).display, "none", state);
        }
        card.dataset.agentState = "left";
        assert.strictEqual(drawn(dot).display, "none", "left");
      });
    });

    it("boxes the row of an agent in a state, and not the row of one who has left", function () {
      const [card] = agents();
      const glyph = card.querySelector(".crew-state");
      const boxed = (element) => drawn(element).borderTopColor !== CLEAR;
      settled(card, () => settled(glyph, () => {
        card.dataset.agentState = "waiting";
        assert.isTrue(boxed(card));
        assert.notStrictEqual(drawn(card).backgroundImage, "none");
        assert.isTrue(boxed(glyph));
        card.dataset.agentState = "left";
        assert.isFalse(boxed(card));
        assert.strictEqual(drawn(card).backgroundImage, "none");
        assert.isFalse(boxed(glyph));
        // Dimmed all the same: part of the record, not of what is happening.
        assert.isBelow(Number(drawn(card).opacity), 1);
      }));
    });

    it("keeps the two controls of a crew together under the lists", function () {
      const [mission, roster] = all(".crew-actions > button");
      assert.deepEqual([mission.id, roster.id], ["manage-mission-crew-inspector", "configure-crew"]);
      assert.deepEqual([mission.textContent, roster.textContent], ["Mission crew", "Workspace roster"]);
      assert.isAtLeast(box(mission).top, box($("crew-mode-hint")).bottom);
      assert.isAtLeast(box($("crew-mode-hint")).top, box($("crew-list")).bottom);
      assert.closeTo(box(mission).top, box(roster).top, 0.5);
      assert.closeTo(box(mission).width, box(roster).width, 0.5);
      assert.isBelow(box(mission).right, box(roster).left);
      // The heading is left with the count and Reviews, which is what it has room for.
      assert.deepEqual(all(`${CREW} > .section-heading button`).map((button) => button.id), ["open-learning-reviews"]);
      // The section's own controls: not the agent cards, nor anything a card may hold.
      assert.deepEqual(all(`${CREW} button`).filter((button) => !button.closest(".crew-card")).map((button) => button.id), [
        "open-learning-reviews", "manage-mission-crew-inspector", "configure-crew",
      ]);
      assert.isTrue(narrow(() => uncut(mission) && uncut(roster)), "neither is cut short in a narrow window");
      // A control that cannot be used now looks it. (Mission crew waits for a turn to finish.)
      const was = mission.disabled;
      try {
        mission.disabled = true;
        assert.isBelow(Number(drawn(mission).opacity), 1);
        assert.strictEqual(drawn(mission).cursor, "not-allowed");
      } finally {
        mission.disabled = was;
      }
    });

    it("opens the Mission's crew and the workspace's roster from them", async function () {
      const closing = async (dialog, close, name) => {
        await until(() => dialog.open, `${name} to open`);
        close.click();
        await until(() => !dialog.open, `${name} to close`);
      };
      await until(() => !$("manage-mission-crew-inspector").disabled, "Mission crew to be available");
      $("manage-mission-crew-inspector").click();
      await closing($("mission-crew-dialog"), $("close-mission-crew-dialog"), "the Mission crew");
      $("configure-crew").click();
      await closing($("crew-dialog"), $("close-crew-dialog"), "the Workspace roster");
    });

    it("says which crew this is: the roster's, or the Mission's own", async function () {
      const missions = Mongo.getCollection("constellation_mission_configs");
      const sessionId = one(".mission-row.current")?.dataset.sessionId;
      assert.ok(sessionId, "the Mission the app opened with");
      await until(() => missions.findOne(sessionId), "the Mission's settings");
      assert.strictEqual(hint(), FOLLOWS);
      const specialists = agents().length - 1;
      assert.isAbove(specialists, 1, "a roster with specialists to choose among");

      const rowan = await Meteor.callAsync("constellation.workspaceMemberCreate", { displayName: "Rowan", title: "Research" });
      let revision = missions.findOne(sessionId).revision;
      try {
        ({ revision } = await Meteor.callAsync("constellation.missionCrewSave", sessionId, revision, {
          memberIds: [rowan], agentMode: "custom", agents: ["researcher"],
        }));
        await until(() => hint() !== FOLLOWS && people().length === 2 && agents().length === 2, "the Mission's own crew to be drawn");
        assert.strictEqual(hint(), `1 of ${specialists} specialists, chosen for this mission`);
        assert.strictEqual(heading().textContent, "CREW 4");
        // Said in full, on a line of its own, where a narrow window has room for it.
        assert.isTrue(narrow(() => box($("crew-mode-hint")).height < 2 * parseFloat(drawn($("crew-mode-hint")).lineHeight)));

        // Somebody who is not the owner is set as the owner is, and says how they reach the Mission.
        const [owner] = people().filter((row) => row.dataset.role === "owner");
        const [guest] = people().filter((row) => row.dataset.role === "participant");
        assert.strictEqual(guest.querySelector("strong").textContent, "Rowan");
        assert.strictEqual(guest.querySelector(".mission-person-copy span").textContent, "Not connected");
        assert.strictEqual(guest.children.length, 2);
        assert.closeTo(box(guest.querySelector(".participant-avatar")).left, box(owner.querySelector(".participant-avatar")).left, 0.5);
        assert.closeTo(box(guest).height, box(owner).height, 0.5);
      } finally {
        ({ revision } = await Meteor.callAsync("constellation.missionCrewSave", sessionId, revision, {
          memberIds: [], agentMode: "inherit", agents: [],
        }));
        await until(() => hint() === FOLLOWS && people().length === 1, "the roster's crew to be drawn again");
        await Meteor.callAsync("constellation.workspaceMemberRemove", rowan, 1);
      }
      assert.strictEqual(agents().length, specialists + 1);
    });
  });
}
