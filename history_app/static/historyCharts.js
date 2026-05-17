import { drawLegend, roundRect } from '/shared/chartCore.js';

export function drawBoxedLegend(ctx, items, x, y, maxWidth) {
  const metrics = legendPanelMetrics(ctx, items, maxWidth);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  ctx.strokeStyle = '#d9dfd8';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, metrics.width, metrics.height, 7);
  ctx.fill();
  ctx.stroke();
  drawLegend(ctx, items, x + metrics.paddingX, y + metrics.paddingY + 9, {
    maxWidth: metrics.width - metrics.paddingX * 2
  });
}

export function legendPanelMetrics(ctx, items, maxWidth) {
  const paddingX = 10;
  const paddingY = 8;
  const rowHeight = 18;
  const gap = 14;
  ctx.font = '12px Inter, system-ui, sans-serif';
  let cursor = 0;
  let rows = 1;
  let usedWidth = 0;

  for (const item of items) {
    const itemWidth = ctx.measureText(item.label).width + 28;
    if (cursor > 0 && cursor + itemWidth > maxWidth - paddingX * 2) {
      usedWidth = Math.max(usedWidth, cursor - gap);
      cursor = 0;
      rows += 1;
    }
    cursor += itemWidth + gap;
  }
  usedWidth = Math.max(usedWidth, cursor - gap);

  return {
    width: Math.min(maxWidth, usedWidth + paddingX * 2),
    height: rows * rowHeight + paddingY * 2,
    paddingX,
    paddingY,
    rows
  };
}
