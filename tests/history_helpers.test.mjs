import test from "node:test";
import assert from "node:assert/strict";

import { cleanPowerAxisMax, formatMinuteOfDay } from "../history_app/static/historyChartMath.js";
import { escapeHtml, sourceLabel } from "../history_app/static/historyFormat.js";

test("EcoFlow chart helpers use clean axis steps and minute labels", () => {
  assert.equal(cleanPowerAxisMax([650], 4), 4000);
  assert.equal(cleanPowerAxisMax([5059], 4), 8000);
  assert.equal(formatMinuteOfDay(870.25), "14:30:15");
});

test("history formatting escapes dynamic text and shortens source labels", () => {
  assert.equal(escapeHtml("<DWD & PV>"), "&lt;DWD &amp; PV&gt;");
  assert.equal(sourceLabel("DWD MOSMIX day-ahead"), "DWD day-ahead");
});
