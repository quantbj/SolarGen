#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DEFAULTS, LOCATION } from "./config.js";
import { buildHistoryForecastUrl, captureDayAheadForecast } from "./historyForecast.js";

const [command, payloadPath] = process.argv.slice(2);

try {
  if (command === "url") {
    const payload = readPayload(payloadPath);
    writeJson({ url: buildHistoryForecastUrl(payload.settings || DEFAULTS, payload.forecast_days || 3) });
  } else if (command === "capture") {
    const payload = readPayload(payloadPath);
    writeJson(captureDayAheadForecast({
      forecast: payload.forecast,
      settings: payload.settings || DEFAULTS,
      now: payload.now ? new Date(payload.now) : new Date()
    }));
  } else if (command === "location") {
    writeJson(LOCATION);
  } else {
    throw new Error("Usage: node src/historyForecastCli.mjs <url|capture|location> [payload.json]");
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function readPayload(path) {
  if (!path) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
