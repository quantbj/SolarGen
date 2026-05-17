export function cleanPowerAxisMax(values, steps) {
  const highestValue = Math.max(1000, ...values.filter(Number.isFinite));
  const minimumStep = 1000;
  return Math.ceil(highestValue / (minimumStep * steps)) * minimumStep * steps;
}

export function formatMinuteOfDay(minute) {
  const totalSeconds = Math.max(0, Math.min(86399, Math.round(Number(minute) * 60)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return seconds ? `${base}:${String(seconds).padStart(2, '0')}` : base;
}
