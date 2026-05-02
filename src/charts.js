import { formatNumber } from "./utils.js";

const COLORS = {
  blue: "#0072b2",
  sky: "#56b4e9",
  vermillion: "#d55e00",
  purple: "#cc79a7",
  yellow: "#f0e442",
  navy: "#2f5d8c",
  battery: "#7b3294",
  black: "#111111",
  grey: "#6f7782"
};

export function renderDailyChart(canvas, days, selectedIndex, onSelectDay) {
  const ctx = setupCanvas(canvas);
  const rect = chartRect(ctx.canvas, 48, 48, 52, 62);
  const maxKwh = Math.max(10, ...days.map(day => day.pv)) * 1.14;
  const maxValue = Math.max(5, ...days.map(day => day.totalValue)) * 1.14;

  drawGrid(ctx, rect, 5, value => `${formatNumber((maxKwh * value) / 5, 0)}`);
  drawRightAxis(ctx, rect, 5, value => `${formatNumber((maxValue * value) / 5, 0)}`);
  drawAxisCaptions(ctx, rect, "kWh", "EUR");
  const barGap = 8;
  const barWidth = Math.max(16, (rect.w - barGap * (days.length - 1)) / days.length);

  days.forEach((day, index) => {
    const x = rect.x + index * (barWidth + barGap);
    const kwhHeight = (day.pv / maxKwh) * rect.h;
    const valueHeight = (day.totalValue / maxValue) * rect.h;
    const groupGap = Math.max(3, barWidth * 0.1);
    const groupedWidth = (barWidth - groupGap) / 2;

    ctx.fillStyle = index === selectedIndex ? COLORS.blue : COLORS.sky;
    roundRect(ctx, x, rect.y + rect.h - kwhHeight, groupedWidth, kwhHeight, 5);
    ctx.fill();

    ctx.fillStyle = COLORS.purple;
    roundRect(ctx, x + groupedWidth + groupGap, rect.y + rect.h - valueHeight, groupedWidth, valueHeight, 4);
    ctx.fill();

    ctx.fillStyle = "#66716a";
    ctx.textAlign = "center";
    const [weekday, date] = day.label.split(" ");
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText(weekday, x + barWidth / 2, rect.y + rect.h + 22);
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.fillText((date || "").replace("/", "."), x + barWidth / 2, rect.y + rect.h + 38);
  });

  drawLegend(ctx, [
    [COLORS.sky, "PV kWh"],
    [COLORS.purple, "EUR value"]
  ], rect.x, 18);

  canvas.onclick = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const index = dayIndexAtX(x, rect, barWidth, barGap, days.length);
    if (index >= 0 && index < days.length) {
      onSelectDay(index);
    }
  };

  canvas.onmousemove = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const index = dayIndexAtX(x, rect, barWidth, barGap, days.length);
    if (index < 0 || y < rect.y || y > rect.y + rect.h + 48) {
      hideTooltip(canvas);
      canvas.style.cursor = "default";
      return;
    }

    const day = days[index];
    canvas.style.cursor = "pointer";
    showTooltip(canvas, x, y, [
      `<strong>${escapeHtml(day.label)}</strong>`,
      `PV: ${formatNumber(day.pv, 1)} kWh`,
      `Value: EUR ${formatNumber(day.totalValue, 2)}`,
      `Saved: EUR ${formatNumber(day.savings, 2)}`,
      `Feed-in: EUR ${formatNumber(day.earnings, 2)}`
    ]);
  };

  canvas.onmouseleave = () => {
    hideTooltip(canvas);
    canvas.style.cursor = "default";
  };
}

export function renderHourlyChart(canvas, day) {
  const ctx = setupCanvas(canvas);
  const rect = chartRect(ctx.canvas, 42, 16, 34, 34);
  const maxValue = Math.max(1, ...day.hours.flatMap(hour => [
    hour.pv,
    hour.load,
    hour.exportKwh,
    hour.charge,
    hour.discharge
  ])) * 1.2;
  const barWidth = rect.w / 24;

  drawGrid(ctx, rect, 4, value => `${formatNumber((maxValue * value) / 4, 1)}`);

  day.hours.forEach(hour => {
    const x = rect.x + hour.hour * barWidth;
    drawBar(ctx, rect, x + 2, barWidth - 4, hour.pv, maxValue, COLORS.blue);
  });

  drawSeriesLine(ctx, rect, day.hours.map(hour => [hour.hour, hour.load]), maxValue, COLORS.vermillion);
  drawSeriesLine(ctx, rect, day.hours.map(hour => [hour.hour, hour.exportKwh]), maxValue, COLORS.navy);

  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  [0, 6, 12, 18, 23].forEach(hour => {
    const x = rect.x + hour * barWidth + barWidth / 2;
    ctx.fillText(`${hour}:00`, x, rect.y + rect.h + 24);
  });

  drawLegend(ctx, [
    [COLORS.blue, "PV"],
    [COLORS.vermillion, "Load"],
    [COLORS.navy, "Export"]
  ], rect.x, 16);
}

export function renderBatteryChart(canvas, day) {
  const ctx = setupCanvas(canvas);
  const rect = chartRect(ctx.canvas, 42, 28, 34, 20);
  const points = day.hours.map(hour => [hour.hour, hour.batteryPercent || 0]);

  drawGrid(ctx, rect, 4, value => `${formatNumber((100 * value) / 4, 0)}%`);
  drawSeriesLine(ctx, rect, points, 100, COLORS.battery, 4);
  drawLegend(ctx, [[COLORS.battery, "Battery charge %"]], rect.x, 16);
  drawTimeLabels(ctx, rect, rect.y + rect.h + 24);

  canvas.onmousemove = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    if (x < rect.x || x > rect.x + rect.w || y < rect.y - 12 || y > rect.y + rect.h + 34) {
      canvas.style.cursor = "default";
      hideTooltip(canvas);
      return;
    }

    const hour = Math.max(0, Math.min(23, Math.round(((x - rect.x) / rect.w) * 23)));
    const value = day.hours.find(item => item.hour === hour)?.batteryPercent || 0;
    canvas.style.cursor = "default";
    showTooltip(canvas, x, y, [
      "<strong>Battery charge</strong>",
      `${formatHour(hour)}: ${formatNumber(value, 0)} %`
    ]);
  };

  canvas.onmouseleave = () => {
    hideTooltip(canvas);
    canvas.style.cursor = "default";
  };
}

export function renderGenerationWeatherChart(canvas, day, hiddenSeries = new Set(), onToggleSeries = () => {}) {
  canvas.dataset.hiddenSeries = Array.from(hiddenSeries).sort().join(",");
  const ctx = setupCanvas(canvas);
  const top = chartRect(ctx.canvas, 44, 66, 134, 46);
  const bottom = {
    x: top.x,
    y: top.y + top.h + 34,
    w: top.w,
    h: 78
  };
  const maxPv = Math.max(1, ...day.hours.flatMap(hour => [
    hour.theoreticalPv,
    hour.pv,
    hour.deliveredPv,
    hour.curtailed
  ])) * 1.18;
  const maxIrradiance = Math.max(1000, ...day.hours.map(hour => hour.irradiance || 0));
  const maxRain = Math.max(2, ...day.hours.map(hour => hour.precipitation || 0)) * 1.15;
  const isVisible = id => !hiddenSeries.has(id);

  drawGrid(ctx, top, 4, value => `${formatNumber((maxPv * value) / 4, 1)}`);
  drawRightAxis(ctx, top, 4, value => `${formatNumber((maxIrradiance * value) / 4, 0)}`);
  drawGrid(ctx, bottom, 2, value => `${formatNumber((100 * value) / 2, 0)}%`);

  const hitTargets = [];
  const lineSeries = [
    {
      id: "theoretical",
      label: "Theoretical potential",
      color: COLORS.sky,
      rect: top,
      max: maxPv,
      width: 2,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.theoreticalPv]),
      fill: "rgba(86, 180, 233, 0.16)"
    },
    {
      id: "rooftop",
      label: "Rooftop PV",
      color: COLORS.blue,
      rect: top,
      max: maxPv,
      width: 3,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.pv])
    },
    {
      id: "delivered",
      label: "After curtailment",
      color: COLORS.navy,
      rect: top,
      max: maxPv,
      width: 3,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.deliveredPv])
    },
    {
      id: "curtailed",
      label: "Curtailed",
      color: COLORS.vermillion,
      rect: top,
      max: maxPv,
      width: 2,
      unit: "kWh/h",
      points: day.hours.map(hour => [hour.hour, hour.curtailed])
    },
    {
      id: "irradiance",
      label: "Irradiance W/m2",
      color: COLORS.purple,
      rect: top,
      max: maxIrradiance,
      width: 2,
      unit: "W/m2",
      points: day.hours.map(hour => [hour.hour, hour.irradiance || 0])
    },
    {
      id: "cloud",
      label: "Cloud %",
      color: COLORS.grey,
      rect: bottom,
      max: 100,
      width: 2,
      unit: "%",
      points: day.hours.map(hour => [hour.hour, hour.cloudCover || 0])
    },
    {
      id: "temperature",
      label: "Temp deg C",
      color: COLORS.yellow,
      rect: bottom,
      max: 40,
      width: 2,
      unit: "deg C",
      points: day.hours.map(hour => [hour.hour, clampWeatherTemp(hour.temperature)])
    }
  ];

  lineSeries.forEach(series => {
    if (!isVisible(series.id)) return;
    if (series.fill) {
      drawFilledCurve(ctx, series.rect, series.points, series.max, series.fill, series.color, series.width);
    } else {
      drawSeriesLine(ctx, series.rect, series.points, series.max, series.color, series.width);
    }
    hitTargets.push({
      id: series.id,
      label: series.label,
      unit: series.unit,
      type: "line",
      points: mapSeriesPoints(series.rect, series.points, series.max),
      values: series.points
    });
  });

  day.hours.forEach(hour => {
    if (!hour.precipitation || !isVisible("rain")) return;
    const barWidth = bottom.w / 24;
    const x = bottom.x + hour.hour * barWidth + 2;
    const width = Math.max(2, barWidth - 4);
    const height = (hour.precipitation / maxRain) * bottom.h;
    drawBar(ctx, bottom, x, width, hour.precipitation, maxRain, COLORS.black);
    hitTargets.push({
      id: "rain",
      label: "Rain",
      unit: "mm/h",
      type: "bar",
      x,
      y: bottom.y + bottom.h - height,
      w: width,
      h: height,
      hour: hour.hour,
      value: hour.precipitation
    });
  });

  drawTimeLabels(ctx, top, canvasCssHeight(canvas) - 17);
  const legendBoxes = drawLegend(ctx, [
    { id: "theoretical", color: COLORS.sky, label: "Theoretical potential", disabled: !isVisible("theoretical") },
    { id: "rooftop", color: COLORS.blue, label: "Rooftop PV", disabled: !isVisible("rooftop") },
    { id: "delivered", color: COLORS.navy, label: "After curtailment", disabled: !isVisible("delivered") },
    { id: "curtailed", color: COLORS.vermillion, label: "Curtailed", disabled: !isVisible("curtailed") },
    { id: "irradiance", color: COLORS.purple, label: "Irradiance W/m2", disabled: !isVisible("irradiance") },
    { id: "cloud", color: COLORS.grey, label: "Cloud %", disabled: !isVisible("cloud") },
    { id: "temperature", color: COLORS.yellow, label: "Temp deg C", disabled: !isVisible("temperature") },
    { id: "rain", color: COLORS.black, label: "Rain mm/h", disabled: !isVisible("rain") }
  ], top.x, 16, { maxWidth: canvas.clientWidth - top.x - 12 });

  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("PV", top.x, top.y + top.h + 18);
  ctx.fillText("Meteo", bottom.x, bottom.y - 10);

  canvas.onclick = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      onToggleSeries(legendHit.id);
      return;
    }

    const curveHit = findNearestSeriesHit(x, y, hitTargets);
    if (curveHit) {
      onToggleSeries(curveHit.id);
    }
  };

  canvas.onmousemove = event => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      canvas.style.cursor = "pointer";
      showTooltip(canvas, x, y, [
        `<strong>${escapeHtml(legendHit.label)}</strong>`,
        "Click to show/hide"
      ]);
      return;
    }

    const curveHit = findNearestSeriesHit(x, y, hitTargets);
    if (!curveHit) {
      canvas.style.cursor = "default";
      hideTooltip(canvas);
      return;
    }

    canvas.style.cursor = "pointer";
    showTooltip(canvas, x, y, [
      `<strong>${escapeHtml(curveHit.label)}</strong>`,
      `${formatHour(curveHit.hour)}: ${formatNumber(curveHit.value, curveHit.unit === "W/m2" || curveHit.unit === "%" ? 0 : 1)} ${curveHit.unit}`
    ]);
  };

  canvas.onmouseleave = () => {
    hideTooltip(canvas);
    canvas.style.cursor = "default";
  };
}

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvasCssHeight(canvas);
  canvas.style.height = `${height}px`;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function chartRect(canvas, left, top, bottom, right) {
  return {
    x: left,
    y: top,
    w: canvas.clientWidth - left - right,
    h: canvasCssHeight(canvas) - top - bottom
  };
}

function canvasCssHeight(canvas) {
  if (!canvas.dataset.cssHeight) {
    canvas.dataset.cssHeight = canvas.getAttribute("height") || "260";
  }
  return Number(canvas.dataset.cssHeight);
}

function drawGrid(ctx, rect, steps, labelForStep) {
  ctx.strokeStyle = "#d9dfd8";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let step = 0; step <= steps; step += 1) {
    const y = rect.y + rect.h - (rect.h * step) / steps;
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.w, y);
    ctx.stroke();
    ctx.fillText(labelForStep(step), rect.x - 8, y);
  }
}

function drawBar(ctx, rect, x, width, value, maxValue, color) {
  const height = (value / maxValue) * rect.h;
  ctx.fillStyle = color;
  roundRect(ctx, x, rect.y + rect.h - height, width, height, 3);
  ctx.fill();
}

function drawSeriesLine(ctx, rect, points, maxValue, color, lineWidth = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  points.forEach(([hour, value], index) => {
    const x = rect.x + (hour / 23) * rect.w;
    const y = rect.y + rect.h - (value / maxValue) * rect.h;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawFilledCurve(ctx, rect, points, maxValue, fill, stroke, lineWidth = 2) {
  const mapped = points.map(([hour, value]) => [
    rect.x + (hour / 23) * rect.w,
    rect.y + rect.h - (value / maxValue) * rect.h
  ]);

  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(mapped[0][0], rect.y + rect.h);
  mapped.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(mapped[mapped.length - 1][0], rect.y + rect.h);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  mapped.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawRightAxis(ctx, rect, steps, labelForStep) {
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let step = 0; step <= steps; step += 1) {
    const y = rect.y + rect.h - (rect.h * step) / steps;
    ctx.fillText(labelForStep(step), rect.x + rect.w + 8, y);
  }
}

function drawAxisCaptions(ctx, rect, leftLabel, rightLabel) {
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(leftLabel, rect.x, rect.y - 15);
  ctx.textAlign = "right";
  ctx.fillText(rightLabel, rect.x + rect.w, rect.y - 15);
}

function drawTimeLabels(ctx, rect, y) {
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  [0, 6, 12, 18, 23].forEach(hour => {
    const x = rect.x + (hour / 23) * rect.w;
    ctx.fillText(`${hour}:00`, x, y);
  });
}

function drawLegend(ctx, items, x, y, options = {}) {
  const normalized = items.map(item => Array.isArray(item)
    ? { color: item[0], label: item[1], id: item[1], disabled: false }
    : item);
  let cursor = x;
  let rowY = y;
  const boxes = [];
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  normalized.forEach(item => {
    const width = ctx.measureText(item.label).width + 28;
    if (options.maxWidth && cursor > x && cursor + width > x + options.maxWidth) {
      cursor = x;
      rowY += 18;
    }

    ctx.globalAlpha = item.disabled ? 0.34 : 1;
    ctx.fillStyle = item.color;
    roundRect(ctx, cursor, rowY - 5, 10, 10, 3);
    ctx.fill();
    ctx.fillStyle = "#66716a";
    ctx.fillText(item.label, cursor + 16, rowY);
    if (item.disabled) {
      ctx.strokeStyle = "#66716a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cursor + 15, rowY);
      ctx.lineTo(cursor + 16 + ctx.measureText(item.label).width, rowY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    boxes.push({
      id: item.id,
      label: item.label,
      x: cursor - 4,
      y: rowY - 10,
      w: width,
      h: 18
    });
    cursor += width + 14;
  });
  return boxes;
}

function roundRect(ctx, x, y, width, height, radius) {
  if (height < 0) return;
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function clampWeatherTemp(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(40, value));
}

function mapSeriesPoints(rect, points, maxValue) {
  return points.map(([hour, value]) => [
    rect.x + (hour / 23) * rect.w,
    rect.y + rect.h - (value / maxValue) * rect.h
  ]);
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function findNearestSeriesHit(x, y, targets) {
  let best = null;
  targets.forEach(target => {
    let distance = Infinity;
    let index = -1;
    if (target.type === "bar") {
      if (pointInRect(x, y, target)) {
        distance = 0;
      }
    } else {
      const nearest = minDistanceToPath(x, y, target.points);
      distance = nearest.distance;
      index = nearest.index;
    }
    if (distance < 10 && (!best || distance < best.distance)) {
      best = { target, distance, index };
    }
  });
  if (!best) return null;
  if (best.target.type === "bar") {
    return {
      id: best.target.id,
      label: best.target.label,
      hour: best.target.hour,
      value: best.target.value,
      unit: best.target.unit
    };
  }
  const raw = best.target.values[Math.max(0, best.index)];
  return {
    id: best.target.id,
    label: best.target.label,
    hour: raw[0],
    value: raw[1],
    unit: best.target.unit
  };
}

function minDistanceToPath(x, y, points) {
  let min = Infinity;
  let bestIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    const distance = distanceToSegment(x, y, points[index - 1], points[index]);
    if (distance < min) {
      min = distance;
      bestIndex = Math.abs(x - points[index - 1][0]) < Math.abs(x - points[index][0]) ? index - 1 : index;
    }
  }
  return { distance: min, index: bestIndex };
}

function distanceToSegment(x, y, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) {
    return Math.hypot(x - a[0], y - a[1]);
  }
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return Math.hypot(x - px, y - py);
}

function dayIndexAtX(x, rect, barWidth, barGap, dayCount) {
  const slot = barWidth + barGap;
  const relative = x - rect.x;
  if (relative < 0) return -1;
  const index = Math.floor(relative / slot);
  if (index < 0 || index >= dayCount) return -1;
  const withinSlot = relative - index * slot;
  return withinSlot <= barWidth ? index : -1;
}

function getTooltip(canvas) {
  const parent = canvas.parentElement;
  let tooltip = parent.querySelector(".chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    parent.appendChild(tooltip);
  }
  return tooltip;
}

function showTooltip(canvas, x, y, lines) {
  const tooltip = getTooltip(canvas);
  tooltip.innerHTML = lines.map(line => `<div>${line}</div>`).join("");
  tooltip.style.display = "block";
  const parentWidth = canvas.parentElement.clientWidth;
  const left = Math.min(parentWidth - tooltip.offsetWidth - 12, Math.max(12, x + 14));
  const top = Math.max(12, y + 14);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip(canvas) {
  const tooltip = canvas.parentElement?.querySelector(".chart-tooltip");
  if (tooltip) {
    tooltip.style.display = "none";
  }
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
