import test from "node:test";
import assert from "node:assert/strict";

import {
  bindSeriesInteractions,
  canvasCssHeight,
  chartRect,
  drawAxisCaptions,
  drawBar,
  drawGrid,
  drawLegend,
  drawRightAxis,
  drawSeriesLine,
  drawTimeLabels,
  hideTooltip,
  mapSeriesPoints,
  pointInRect,
  setupCanvas,
  showSeriesTooltip,
  showToggleTooltip,
  showTooltip
} from "../src/chartCore.js";

test("canvas setup, rectangles, axes, legend, and series drawing use shared primitives", () => {
  withDom(() => {
    const canvas = fakeCanvas();
    const ctx = setupCanvas(canvas);
    const rect = chartRect(canvas, 40, 20, 30, 50);

    assert.equal(canvas.width, 800);
    assert.equal(canvas.height, 640);
    assert.deepEqual(rect, { x: 40, y: 20, w: 310, h: 270 });

    drawGrid(ctx, rect, 2, step => `${step}`);
    drawRightAxis(ctx, rect, 2, step => `${step}`);
    drawAxisCaptions(ctx, rect, "left", "right");
    drawTimeLabels(ctx, rect, 300);
    drawBar(ctx, rect, 50, 10, 2, 4, "#000");
    drawSeriesLine(ctx, rect, [[0, 0], [12, 2], [23, 1]], 4, "#111", 3);
    const boxes = drawLegend(ctx, [
      { id: "a", color: "#111", label: "Alpha" },
      { id: "b", color: "#222", label: "Beta", disabled: true }
    ], 40, 16, { maxWidth: 90 });

    assert.equal(boxes.length, 2);
    assert.ok(ctx.calls.length > 20);
  });
});

test("tooltips are created, escaped, positioned, and hidden", () => {
  withDom(() => {
    const canvas = fakeCanvas();
    showTooltip(canvas, 30, 40, ["<strong>Safe</strong>", "Value"]);
    showToggleTooltip(canvas, { label: "<Legend>" }, 30, 40);
    showSeriesTooltip(canvas, { label: "PV", hour: 8, value: 1.234, unit: "kWh/h" }, 30, 40);

    const tooltip = canvas.parentElement.querySelector(".chart-tooltip");
    assert.equal(tooltip.style.display, "block");
    assert.match(tooltip.innerHTML, /08:00/);

    hideTooltip(canvas);
    assert.equal(tooltip.style.display, "none");
  });
});

test("shared interactions toggle legend items and show body values", () => {
  withDom(() => {
    const canvas = fakeCanvas();
    const toggled = [];
    bindSeriesInteractions(
      canvas,
      [{ id: "pv", label: "PV", x: 0, y: 0, w: 80, h: 30 }],
      [{
        id: "pv",
        label: "PV",
        unit: "kWh/h",
        type: "line",
        points: [[0, 100], [100, 100]],
        values: [[10, 3], [11, 4]]
      }],
      id => toggled.push(id)
    );

    canvas.onclick({ clientX: 10, clientY: 10 });
    assert.deepEqual(toggled, ["pv"]);

    canvas.onmousemove({ clientX: 50, clientY: 100 });
    assert.match(canvas.parentElement.querySelector(".chart-tooltip").innerHTML, /PV/);

    canvas.onmouseleave();
    assert.equal(canvas.style.cursor, "default");
  });
});

test("geometry helpers map points and rectangles", () => {
  const rect = { x: 10, y: 20, w: 230, h: 100 };
  assert.deepEqual(mapSeriesPoints(rect, [[0, 0], [23, 10]], 10), [[10, 120], [240, 20]]);
  assert.equal(pointInRect(11, 21, rect), true);
  assert.equal(pointInRect(9, 21, rect), false);
});

function withDom(run) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = { devicePixelRatio: 2 };
  global.document = {
    createElement() {
      return fakeElement();
    }
  };
  try {
    run();
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function fakeCanvas() {
  const ctx = fakeContext();
  return {
    clientWidth: 400,
    dataset: {},
    attrs: { height: "320" },
    height: 0,
    width: 0,
    style: {},
    parentElement: fakeElement(400),
    getAttribute(name) { return this.attrs[name]; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    getContext(type) {
      assert.equal(type, "2d");
      return ctx;
    }
  };
}

function fakeElement(width = 400) {
  const children = [];
  return {
    children,
    clientWidth: width,
    className: "",
    innerHTML: "",
    offsetWidth: 120,
    style: {},
    appendChild(child) { children.push(child); child.parentElement = this; },
    querySelector(selector) {
      if (selector === ".chart-tooltip") return children.find(child => child.className === "chart-tooltip") || null;
      return null;
    }
  };
}

function fakeContext() {
  const ctx = {
    calls: [],
    globalAlpha: 1,
    setTransform: (...args) => ctx.calls.push(["setTransform", ...args]),
    clearRect: (...args) => ctx.calls.push(["clearRect", ...args]),
    beginPath: () => ctx.calls.push(["beginPath"]),
    moveTo: (...args) => ctx.calls.push(["moveTo", ...args]),
    lineTo: (...args) => ctx.calls.push(["lineTo", ...args]),
    stroke: () => ctx.calls.push(["stroke"]),
    fill: () => ctx.calls.push(["fill"]),
    closePath: () => ctx.calls.push(["closePath"]),
    arcTo: (...args) => ctx.calls.push(["arcTo", ...args]),
    fillText: (...args) => ctx.calls.push(["fillText", ...args]),
    measureText: text => ({ width: String(text).length * 6 })
  };
  return ctx;
}
