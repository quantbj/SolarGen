import { formatNumber } from "./utils.js";

export const COLORS = {
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

/**
 * Reset and scale a canvas for high-DPI displays while preserving its CSS height.
 * Input is a canvas element; output is the 2D rendering context in CSS-pixel coordinates.
 */
export function setupCanvas(canvas) {
  const ratio = globalThis.window?.devicePixelRatio || 1;
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

/**
 * Return the stable CSS height for a canvas. The first rendered height is cached so redraws
 * cannot accidentally grow a chart by reading the high-DPI backing-store height.
 */
export function canvasCssHeight(canvas) {
  if (!canvas.dataset.cssHeight) {
    canvas.dataset.cssHeight = canvas.getAttribute("height") || "260";
  }
  return Number(canvas.dataset.cssHeight);
}

/**
 * Compute an inner plotting rectangle from canvas size and fixed margins.
 */
export function chartRect(canvas, left, top, bottom, right) {
  return {
    x: left,
    y: top,
    w: canvas.clientWidth - left - right,
    h: canvasCssHeight(canvas) - top - bottom
  };
}

/**
 * Draw horizontal grid lines and the left y-axis labels.
 */
export function drawGrid(ctx, rect, steps, labelForStep) {
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

export function drawRightAxis(ctx, rect, steps, labelForStep) {
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let step = 0; step <= steps; step += 1) {
    const y = rect.y + rect.h - (rect.h * step) / steps;
    ctx.fillText(labelForStep(step), rect.x + rect.w + 8, y);
  }
}

export function drawAxisCaptions(ctx, rect, leftLabel, rightLabel) {
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(leftLabel, rect.x, rect.y - 15);
  ctx.textAlign = "right";
  ctx.fillText(rightLabel, rect.x + rect.w, rect.y - 15);
}

export function drawTimeLabels(ctx, rect, y) {
  ctx.fillStyle = "#66716a";
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  [0, 6, 12, 18, 23].forEach(hour => {
    const x = rect.x + (hour / 23) * rect.w;
    ctx.fillText(`${hour}:00`, x, y);
  });
}

export function drawBar(ctx, rect, x, width, value, maxValue, color) {
  const height = (value / maxValue) * rect.h;
  ctx.fillStyle = color;
  roundRect(ctx, x, rect.y + rect.h - height, width, height, 3);
  ctx.fill();
}

export function drawSeriesLine(ctx, rect, points, maxValue, color, lineWidth = 2) {
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

/**
 * Draw a wrapping legend and return hit boxes for pointer interaction.
 */
export function drawLegend(ctx, items, x, y, options = {}) {
  let cursor = x;
  let rowY = y;
  const boxes = [];
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  items.forEach(item => {
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
    boxes.push({ id: item.id, label: item.label, x: cursor - 4, y: rowY - 10, w: width, h: 18 });
    cursor += width + 14;
  });
  return boxes;
}

/**
 * Shared pointer behavior for line/bar charts. Legend hits toggle visibility; chart-body
 * hits only show values, which keeps touch devices from conflating tap and hover.
 */
export function bindSeriesInteractions(canvas, legendBoxes, hitTargets, onToggleSeries) {
  const handlePoint = (event, fromClick = false) => {
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const legendHit = legendBoxes.find(item => pointInRect(x, y, item));
    if (legendHit) {
      canvas.style.cursor = "pointer";
      if (fromClick) onToggleSeries(legendHit.id);
      else showToggleTooltip(canvas, legendHit, x, y);
      return;
    }

    const seriesHit = findNearestSeriesHit(x, y, hitTargets);
    if (seriesHit) {
      canvas.style.cursor = "pointer";
      showSeriesTooltip(canvas, seriesHit, x, y);
      return;
    }

    canvas.style.cursor = "default";
    hideTooltip(canvas);
  };

  canvas.onclick = event => handlePoint(event, true);
  canvas.onmousemove = event => handlePoint(event, false);
  canvas.onmouseleave = () => {
    hideTooltip(canvas);
    canvas.style.cursor = "default";
  };
}

export function mapSeriesPoints(rect, points, maxValue) {
  return points.map(([hour, value]) => [
    rect.x + (hour / 23) * rect.w,
    rect.y + rect.h - (value / maxValue) * rect.h
  ]);
}

export function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function findNearestSeriesHit(x, y, targets) {
  let best = null;
  targets.forEach(target => {
    let distance = Infinity;
    let index = -1;
    if (target.type === "bar") {
      if (pointInRect(x, y, target)) distance = 0;
    } else {
      const nearest = minDistanceToPath(x, y, target.points);
      distance = nearest.distance;
      index = nearest.index;
    }
    if (distance < 18 && (!best || distance < best.distance)) {
      best = { target, distance, index };
    }
  });
  if (!best) return null;
  if (best.target.type === "bar") {
    return pickHit(best.target, best.target.hour, best.target.value);
  }
  const raw = best.target.values[Math.max(0, best.index)];
  return pickHit(best.target, raw[0], raw[1]);
}

export function dayIndexAtX(x, rect, barWidth, barGap, dayCount) {
  const slot = barWidth + barGap;
  const relative = x - rect.x;
  if (relative < 0) return -1;
  const index = Math.floor(relative / slot);
  if (index < 0 || index >= dayCount) return -1;
  return relative - index * slot <= barWidth ? index : -1;
}

export function showToggleTooltip(canvas, legendHit, x, y) {
  showTooltip(canvas, x, y, [`<strong>${escapeHtml(legendHit.label)}</strong>`, "Click to show/hide"]);
}

export function showSeriesTooltip(canvas, seriesHit, x, y) {
  showTooltip(canvas, x, y, [
    `<strong>${escapeHtml(seriesHit.label)}</strong>`,
    `${formatHour(seriesHit.hour)}: ${formatNumber(seriesHit.value, decimalsForUnit(seriesHit.unit))} ${seriesHit.unit}`
  ]);
}

export function showTooltip(canvas, x, y, lines) {
  const tooltip = getTooltip(canvas);
  tooltip.innerHTML = lines.map(line => `<div>${line}</div>`).join("");
  tooltip.style.display = "block";
  const parentWidth = canvas.parentElement.clientWidth;
  const left = Math.min(parentWidth - tooltip.offsetWidth - 12, Math.max(12, x + 14));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(12, y + 14)}px`;
}

export function hideTooltip(canvas) {
  const tooltip = canvas.parentElement?.querySelector(".chart-tooltip");
  if (tooltip) tooltip.style.display = "none";
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function roundRect(ctx, x, y, width, height, radius) {
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

function pickHit(target, hour, value) {
  return { id: target.id, label: target.label, hour, value, unit: target.unit };
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
  if (dx === 0 && dy === 0) return Math.hypot(x - a[0], y - a[1]);
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  return Math.hypot(x - px, y - py);
}

function decimalsForUnit(unit) {
  if (unit === "%" || unit === "deg C") return 0;
  return 1;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}
