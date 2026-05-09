import test from "node:test";
import assert from "node:assert/strict";

import { renderBatteryChart, renderDailyChart, renderGenerationWeatherChart, renderHourlyChart } from "../src/charts.js";

test("forecast chart renderers draw and wire interactions without browser dependencies", () => {
  withDom(() => {
    const day = sampleDay();
    const days = [day, { ...day, label: "Sun 10/05", pv: 18, totalValue: 4 }];
    const toggled = [];
    let selected = -1;

    const daily = fakeCanvas();
    renderDailyChart(daily, days, 0, index => { selected = index; }, new Set(), id => toggled.push(id));
    daily.onmousemove({ clientX: 70, clientY: 150 });
    daily.onclick({ clientX: 55, clientY: 18 });
    daily.onclick({ clientX: 65, clientY: 150 });
    assert.equal(toggled[0], "pv");
    assert.equal(selected, 0);

    const generation = fakeCanvas(480, 320);
    renderGenerationWeatherChart(generation, day, new Set(["rain"]), id => toggled.push(id));
    generation.onmousemove({ clientX: 170, clientY: 150 });
    generation.onclick({ clientX: 60, clientY: 16 });
    assert.ok(toggled.includes("rooftop"));

    const hourly = fakeCanvas(480, 240);
    renderHourlyChart(hourly, day, new Set(), id => toggled.push(id));
    hourly.onmousemove({ clientX: 180, clientY: 100 });
    hourly.onclick({ clientX: 50, clientY: 16 });
    assert.ok(toggled.includes("pv"));

    const battery = fakeCanvas(480, 180);
    renderBatteryChart(battery, day, new Set(), id => toggled.push(id));
    battery.onmousemove({ clientX: 180, clientY: 90 });
    battery.onclick({ clientX: 50, clientY: 16 });
    assert.ok(toggled.includes("battery"));

    assert.ok(daily.getContext("2d").calls.length > 0);
  });
});

function sampleDay() {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    time: `2026-05-09T${String(hour).padStart(2, "0")}:00`,
    pv: hour >= 9 && hour <= 16 ? 5 : 0,
    deliveredPv: hour >= 9 && hour <= 16 ? 4.5 : 0,
    curtailed: hour >= 11 && hour <= 14 ? 0.5 : 0,
    load: 0.4,
    exportKwh: hour >= 9 && hour <= 16 ? 3 : 0,
    charge: hour >= 10 && hour <= 14 ? 0.8 : 0,
    discharge: hour >= 19 && hour <= 21 ? 0.4 : 0,
    batteryPercent: Math.min(100, 30 + hour * 2),
    cloudCover: hour < 12 ? 70 : 35,
    temperature: 12 + hour,
    precipitation: hour === 15 ? 0.6 : 0
  }));
  return {
    label: "Sat 09/05",
    pv: 40,
    totalValue: 5,
    savings: 3,
    earnings: 2,
    hours
  };
}

function withDom(run) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = { devicePixelRatio: 1 };
  global.document = { createElement: () => fakeElement() };
  try {
    run();
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
  }
}

function fakeCanvas(width = 480, height = 280) {
  const ctx = fakeContext();
  const canvas = {
    clientWidth: width,
    dataset: {},
    attrs: { height: String(height) },
    height: 0,
    width: 0,
    style: {},
    parentElement: fakeElement(width),
    getAttribute(name) { return this.attrs[name]; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    getContext() { return ctx; }
  };
  ctx.canvas = canvas;
  return canvas;
}

function fakeElement(width = 480) {
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
