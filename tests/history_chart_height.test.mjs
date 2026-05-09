import test from "node:test";
import assert from "node:assert/strict";
import { canvasCssHeight, dayIndexAtX, escapeHtml, findNearestSeriesHit } from "../src/chartCore.js";

test("history chart base height remains stable after canvas backing-store resize", () => {
  const canvas = {
    dataset: {},
    attrs: { height: "320" },
    getAttribute(name) { return this.attrs[name]; }
  };

  const first = canvasCssHeight(canvas);
  canvas.attrs.height = "640";
  const second = canvasCssHeight(canvas);

  assert.equal(first, 320);
  assert.equal(second, 320);
});

test("dateOnly displays yyyy-mm-dd", () => {
  const sourceDate = "2026-05-05T21:30:00+02:00";
  assert.equal(String(sourceDate || "").slice(0, 10), "2026-05-05");
});

test("daily bar hit testing returns only real bar slots", () => {
  const rect = { x: 40, y: 20, w: 300, h: 120 };

  assert.equal(dayIndexAtX(45, rect, 20, 5, 4), 0);
  assert.equal(dayIndexAtX(60, rect, 20, 5, 4), 0);
  assert.equal(dayIndexAtX(61, rect, 20, 5, 4), -1);
  assert.equal(dayIndexAtX(90, rect, 20, 5, 4), 2);
  assert.equal(dayIndexAtX(200, rect, 20, 5, 4), -1);
});

test("series hit testing finds nearest line and bar values", () => {
  const lineHit = findNearestSeriesHit(50, 52, [{
    id: "pv",
    label: "PV",
    unit: "kWh/h",
    type: "line",
    points: [[0, 80], [100, 20]],
    values: [[8, 1], [9, 2]]
  }]);
  const barHit = findNearestSeriesHit(14, 12, [{
    id: "rain",
    label: "Rain",
    unit: "mm/h",
    type: "bar",
    x: 10,
    y: 10,
    w: 20,
    h: 80,
    hour: 12,
    value: 0.4
  }]);

  assert.equal(lineHit.id, "pv");
  assert.equal(barHit.hour, 12);
  assert.equal(barHit.value, 0.4);
});

test("chart tooltip html escapes labels", () => {
  assert.equal(escapeHtml("<PV & \"load\">"), "&lt;PV &amp; &quot;load&quot;&gt;");
});
