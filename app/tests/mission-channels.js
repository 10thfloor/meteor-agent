import { assert } from "chai";
import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";

if (Meteor.isClient) {
  // The Channels section of the Mission inspector: the channel conversations
  // attached to the open Mission, or one line when there are none.
  describe("Mission channels: the panel", function () {
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
    const rows = () => all("#mission-surface-list .surface-list-item");
    const texts = (selector) => rows().map((row) => row.querySelector(selector).textContent);
    const missionId = () => one(".mission-row.current")?.dataset.sessionId;
    const participation = () => Mongo.getCollection("constellation_mission_participation");
    const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);

    // Three conversations in the shape the server publishes them.
    const conversations = () => [
      { key: "surface:a", kind: "slack", audience: "group", status: "bound", participantKey: "owner", lastActivityAt: minutesAgo(5) },
      { key: "surface:b", kind: "sms", audience: "direct", status: "bound", lastActivityAt: minutesAgo(0) },
      { key: "surface:c", kind: "email", audience: "direct", status: "closing", lastActivityAt: minutesAgo(26 * 60) },
    ];

    // The test workspace has no channel connected, so the conversations are
    // written into the client's copy of the published document, which is what
    // the page renders from. They are removed again afterwards.
    const withConversations = async (look) => {
      const id = missionId();
      const surfaces = conversations();
      participation()._collection.update(id, { $set: { surfaces } });
      try {
        await until(() => rows().length === surfaces.length, "the conversations to be drawn");
        return await look();
      } finally {
        participation()._collection.update(id, { $set: { surfaces: [] } });
        await until(() => rows().length === 0, "the list to be empty again");
      }
    };

    before(async function () {
      await until(() => $("app-frame")?.dataset.startupState === "ready", "the workspace to start", 30_000);
      await until(() => missionId() && participation()?.findOne(missionId()), "the open Mission's participation");
    });

    it("says a Mission with no channel conversation is on the desktop only", function () {
      assert.strictEqual(rows().length, 0);
      assert.isTrue($("mission-surface-list").hidden);
      assert.isFalse($("mission-surface-empty").hidden);
      assert.match($("mission-surface-empty").textContent, /^Desktop only\./);
      assert.isTrue($("mission-surface-count").hidden, "no count beside the heading");
    });

    it("lists each conversation with its channel, who it reaches and when it was last active", async function () {
      await withConversations(() => {
        assert.deepEqual(texts("strong"), ["Slack", "SMS", "Email"]);
        assert.deepEqual(texts("small"), ["You · Group · active 5m ago", "Direct · active now", "Direct · active 1d ago"]);
        assert.deepEqual(texts(".surface-status"), ["Connected", "Connected", "Closing"]);
        assert.isTrue($("mission-surface-empty").hidden);
        assert.isFalse($("mission-surface-count").hidden);
        assert.strictEqual($("mission-surface-count").textContent, "3");
      });
      assert.isTrue($("mission-surface-count").hidden);
      assert.isFalse($("mission-surface-empty").hidden);
    });

    it("uses the Channels page's icon for each channel, so Slack and SMS differ", async function () {
      await withConversations(() => {
        assert.deepEqual(texts(".surface-kind-icon"), ["S", "••", "@"]);
      });
    });

    it("draws a conversation's row like a person's row in the Crew section", async function () {
      await withConversations(() => {
        const [row] = rows();
        const person = one("#mission-crew-people .mission-person-row");
        const pairs = {
          name: [row.querySelector("strong"), person.querySelector("strong")],
          line: [row.querySelector("small"), person.querySelector(".mission-person-copy span")],
          icon: [row.querySelector(".surface-kind-icon"), person.querySelector(".participant-avatar")],
        };
        const same = (pair, read, what) => assert.strictEqual(read(pair[0]), read(pair[1]), what);
        same(pairs.name, (element) => drawn(element).fontSize, "name size");
        same(pairs.line, (element) => drawn(element).fontSize, "line size");
        same(pairs.line, (element) => drawn(element).color, "line colour");
        same(pairs.icon, (element) => drawn(element).fontSize, "icon letter size");
        for (const side of ["width", "height", "left"]) {
          assert.closeTo(box(pairs.icon[0])[side], box(pairs.icon[1])[side], 0.5, `icon ${side}`);
        }
        assert.closeTo(box(pairs.name[0]).left, box(pairs.name[1]).left, 0.5, "where a name starts");
        assert.closeTo(box(row).height, box(person).height, 0.5, "row height");
        // No box around a row, and the status ends on the section's right edge.
        assert.strictEqual(drawn(row).borderTopColor, "rgba(0, 0, 0, 0)");
        assert.strictEqual(drawn(row).backgroundColor, "rgba(0, 0, 0, 0)");
        const settings = one('#inspector-panel-crew [data-view-link="channels"]');
        assert.closeTo(box(row.querySelector(".surface-status")).right, box(settings).right, 0.5);
      });
    });

    it("shows a status that can be read, and marks a closing conversation", async function () {
      await withConversations(() => {
        const [connected, , closing] = rows().map((row) => row.querySelector(".surface-status"));
        assert.isAtLeast(parseFloat(drawn(connected).fontSize), 11);
        assert.notStrictEqual(drawn(closing).color, drawn(connected).color);
      });
    });
  });
}
