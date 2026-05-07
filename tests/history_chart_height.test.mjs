import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../history_app/static/history.js", import.meta.url), "utf8");
const match = source.match(new RegExp("function chartBaseHeight[\\s\\S]*?\\n}\\n"));
if (!match) throw new Error("chartBaseHeight function not found");

test("history chart base height remains stable after canvas backing-store resize", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(match[0], context);

  const canvas = {
    dataset: {},
    attrs: { height: "320" },
    getAttribute(name) { return this.attrs[name]; }
  };

  const first = context.chartBaseHeight(canvas);
  canvas.attrs.height = "640";
  const second = context.chartBaseHeight(canvas);

  assert.equal(first, 320);
  assert.equal(second, 320);
});


test("dateOnly displays yyyy-mm-dd", () => {
  const sourceDate = "2026-05-05T21:30:00+02:00";
  assert.equal(String(sourceDate || "").slice(0, 10), "2026-05-05");
});
