export function formatDay(dateString) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit"
  }).format(new Date(`${dateString}T12:00:00`));
}

export function formatNumber(value, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return Number(value).toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function formatMoney(value) {
  return `EUR ${formatNumber(value, 2)}`;
}

export function valueAt(array, index, fallback) {
  return Array.isArray(array) && array[index] !== null && array[index] !== undefined ? array[index] : fallback;
}

export function dayOfYear(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  return Math.floor((date - start) / 86400000);
}

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}
