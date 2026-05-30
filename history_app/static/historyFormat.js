export function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

export function todayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function fmt(value, decimals) {
  return Number(value).toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function signed(value, decimals) {
  return `${value > 0 ? '+' : ''}${fmt(value, decimals)}`;
}

export function sourceLabel(source) {
  return String(source || '')
    .replace('Open-Meteo ', 'OM ')
    .replace('DWD MOSMIX ', 'DWD ');
}

export function simpleLabel(source) {
  if (source === 'Production blend day-ahead') return 'Production blend';
  if (source === 'DWD MOSMIX day-ahead') return 'DWD stable input';
  if (source === 'DWD MOSMIX same-day') return 'DWD current';
  return 'Production model';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}
