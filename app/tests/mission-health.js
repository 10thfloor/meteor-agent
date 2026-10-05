import { assert } from "chai";
import { Meteor } from "meteor/meteor";
import {
  compactCount,
  missionHealthState,
  missionMeters,
  tokenTotals,
} from "../imports/constellation/mission-health";

// What the Mission health panel says, apart from the page: three alerts, a
// meter for each, and one state line that names the alert that is nearest.
describe("Mission health", function () {
  const alerts = { turns: 80, toolCalls: 40, spend: 5 };
  const byKey = (meters) => Object.fromEntries(meters.map((meter) => [meter.key, meter]));
  const stateOf = (extra, spent = {}, usage = {}) =>
    missionHealthState({ status: "active", archived: false, runtime: "idle", phase: "idle", busy: false, meters: missionMeters(usage, spent, alerts), ...extra });

  it("gives each alert a meter of its own, in the order they are shown", function () {
    const meters = missionMeters({ input: 900, output: 300, cost: 1.2 }, { turns: 8, toolCalls: 4 }, alerts);
    assert.deepEqual(meters.map((meter) => [meter.key, meter.label, meter.usedText, meter.alertText, meter.level]), [
      ["turns", "Turns", "8", "80", "ok"],
      ["toolCalls", "Tool calls", "4", "40", "ok"],
      ["spend", "Model spend", "$1.20", "$5.00", "ok"],
    ]);
    assert.closeTo(byKey(meters).turns.fill, 0.1, 1e-9);
    assert.closeTo(byKey(meters).spend.fill, 0.24, 1e-9);
  });

  it("says near from four fifths of an alert, and reached at it", function () {
    const level = (turns) => byKey(missionMeters({}, { turns }, alerts)).turns.level;
    assert.deepEqual([63, 64, 79, 80, 200].map(level), ["ok", "near", "near", "reached", "reached"]);
    // Past its alert a meter is full, not wider than its track.
    assert.strictEqual(byKey(missionMeters({}, { turns: 200 }, alerts)).turns.fill, 1);
  });

  it("shows something for anything used, and nothing for nothing", function () {
    const fill = (cost) => byKey(missionMeters({ cost }, {}, alerts)).spend.fill;
    assert.strictEqual(fill(0), 0);
    assert.isAbove(fill(0.01), 0.01);
    assert.isBelow(fill(0.01), 0.02);
  });

  it("takes an alert set to nothing as reached by the first of anything", function () {
    const tools = (toolCalls) => byKey(missionMeters({}, { toolCalls }, { ...alerts, toolCalls: 0 })).toolCalls;
    assert.deepInclude(tools(0), { level: "ok", fill: 0, alertText: "0" });
    assert.deepInclude(tools(1), { level: "reached", fill: 1 });
  });

  it("has an answer for a Mission with nothing recorded yet", function () {
    assert.deepEqual(missionMeters(undefined, undefined, alerts).map((meter) => [meter.usedText, meter.level, meter.fill]), [
      ["0", "ok", 0], ["0", "ok", 0], ["$0.00", "ok", 0],
    ]);
    assert.deepEqual(tokenTotals(undefined), { total: "0", split: "" });
  });

  it("says an alert is near or reached in two words, and which one in full", function () {
    assert.deepEqual(stateOf({}, { turns: 70, toolCalls: 36 }), {
      key: "near", label: "Nearing alert", detail: "Nearing the tool-call alert: 36 of 40",
    });
    assert.deepEqual(stateOf({}, { turns: 70 }, { cost: 4.5 }), {
      key: "near", label: "Nearing alert", detail: "Nearing the spend alert: $4.50 of $5.00",
    });
    assert.deepEqual(stateOf({}, { turns: 80, toolCalls: 36 }), {
      key: "reached", label: "Alert reached", detail: "Turn alert reached: 80 of 80",
    });
    // Of two equally near, the one shown first.
    assert.strictEqual(stateOf({}, { turns: 80, toolCalls: 40 }).detail, "Turn alert reached: 80 of 80");
    assert.strictEqual(stateOf({}, { turns: 100 }, { cost: 20 }).detail, "Spend alert reached: $20.00 of $5.00");
  });

  it("puts what stops a Mission before what needs somebody, and that before what is merely happening", function () {
    const over = { turns: 80 };
    const said = (extra, spent) => { const { key, label } = stateOf(extra, spent); return [key, label]; };
    assert.deepEqual(said({ status: "completed", archived: true, runtime: "error" }, over), ["archived", "Archived"]);
    assert.deepEqual(said({ status: "completed", runtime: "error" }, over), ["completed", "Completed"]);
    assert.deepEqual(said({ status: "paused", runtime: "error" }, over), ["paused", "Paused"]);
    assert.deepEqual(said({ runtime: "error" }, over), ["attention", "Needs attention"]);
    assert.deepEqual(said({ phase: "awaiting", runtime: "stopped", busy: true }, over), ["reached", "Alert reached"]);
    assert.deepEqual(said({ phase: "awaiting", runtime: "stopped", busy: true }), ["awaiting", "Awaiting you"]);
    assert.deepEqual(said({ runtime: "stopped", busy: true }), ["stopped", "Stopped"]);
    assert.deepEqual(said({ busy: true }), ["active", "Active"]);
    assert.deepEqual(said({}), ["nominal", "Nominal"]);
    // Where the label already says everything, the full form is the label.
    assert.strictEqual(stateOf({}).detail, "Nominal");
  });

  it("totals tokens, and says where they went once there are any", function () {
    assert.deepEqual(tokenTotals({ input: 1200, output: 345 }), { total: "1.5k", split: "1.2k in · 345 out" });
    assert.deepEqual(tokenTotals({ input: 0, output: 0 }), { total: "0", split: "" });
    assert.deepEqual([0, 999, 1000, 12345].map(compactCount), ["0", "999", "1.0k", "12.3k"]);
  });
});

if (Meteor.isClient) {
  // The page itself: the panel as the app draws it for the Mission it opens with.
  describe("Mission health: the panel", function () {
    this.timeout(60_000);

    const $ = (id) => document.getElementById(id);
    const until = async (check, what, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const meter = (key) => document.querySelector(`.health-meter[data-meter="${key}"]`);
    const reading = (key) => {
      const row = meter(key);
      const bar = row.querySelector('[role="meter"]');
      return {
        text: row.querySelector(".health-meter-line b").textContent,
        level: row.dataset.level,
        now: bar.getAttribute("aria-valuenow"),
        max: bar.getAttribute("aria-valuemax"),
        said: bar.getAttribute("aria-valuetext"),
        width: bar.querySelector("i").getBoundingClientRect().width,
      };
    };

    before(async function () {
      await until(() => $("app-frame")?.dataset.startupState === "ready", "the workspace to start", 30_000);
      // The panel is on the Missions view's Crew tab, which is where the app starts.
      await until(() => !!meter("turns")?.title, "the panel to be drawn");
    });

    it("draws a meter for each alert of a Mission nothing has happened in", function () {
      assert.deepEqual(reading("turns"), { text: "0 / 80", level: "ok", now: "0", max: "80", said: "0 of 80", width: 0 });
      assert.deepEqual(reading("toolCalls"), { text: "0 / 40", level: "ok", now: "0", max: "40", said: "0 of 40", width: 0 });
      assert.deepEqual(reading("spend"), { text: "$0.00 / $5.00", level: "ok", now: "0", max: "5", said: "$0.00 of $5.00", width: 0 });
      assert.strictEqual($("usage-tokens").textContent, "0");
      assert.strictEqual($("usage-token-split").textContent, "");
      assert.strictEqual($("health-label").textContent, "Nominal");
      assert.strictEqual($("health-label").dataset.state, "nominal");
      assert.include(meter("spend").title, "Mission settings");
    });

    it("gives each meter a name a screen reader can say", function () {
      for (const key of ["turns", "toolCalls", "spend"]) {
        const bar = meter(key).querySelector('[role="meter"]');
        const label = document.getElementById(bar.getAttribute("aria-labelledby"));
        assert.strictEqual(label.textContent, meter(key).querySelector(".health-meter-line > span").textContent);
      }
    });

    it("fills a meter by its own share and colours it by its own level", function () {
      // The page draws what `--meter-fill` and `data-level` say; set them as the app does and look.
      const row = meter("toolCalls");
      const bar = row.querySelector('[role="meter"]');
      const filled = bar.querySelector("i");
      const before = { fill: row.style.getPropertyValue("--meter-fill"), level: row.dataset.level };
      const colour = () => getComputedStyle(filled).backgroundColor;
      try {
        // The bar eases to its new width and colour; the test wants where it ends up.
        filled.style.transition = "none";
        row.style.setProperty("--meter-fill", "0.5");
        const ok = colour();
        assert.closeTo(filled.getBoundingClientRect().width, bar.getBoundingClientRect().width / 2, 1);
        row.dataset.level = "near";
        const near = colour();
        row.dataset.level = "reached";
        const reached = colour();
        assert.strictEqual(new Set([ok, near, reached]).size, 3);
        // The number that is over says so too.
        assert.strictEqual(getComputedStyle(row.querySelector("[data-used]")).color, reached);
      } finally {
        row.style.setProperty("--meter-fill", before.fill);
        row.dataset.level = before.level;
        filled.style.transition = "";
      }
    });
  });
}
