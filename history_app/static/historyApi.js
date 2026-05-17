export async function fetchComparisons() {
  return fetchJson('/api/comparisons');
}

export async function fetchForecast(id) {
  return fetchJson(`/api/forecast?id=${encodeURIComponent(id)}`);
}

export async function fetchEcoflowTicks(date) {
  return fetchJson(`/api/ecoflow/ticks?date=${encodeURIComponent(date)}`);
}

export async function captureForecast(path) {
  return fetchJson(path, { method: 'POST', body: '{}' });
}

export async function saveActuals(payload) {
  return fetchJson('/api/actuals', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...options
    });
  } catch (error) {
    throw new Error('Cannot reach the local SolarGen history server. Start it with: python3 -m history_app.server');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
