const SOURCE_LABELS = {
  total: "Alle Quellen",
  solar: "Solar",
  wind: "Wind",
  biomass: "Biomasse",
  water: "Wasser"
};

const SOURCE_COLORS = {
  solar: "#cc8a1e",
  wind: "#356f95",
  biomass: "#21785a",
  water: "#4f8fb7",
  total: "#21785a"
};

const state = {
  summary: null,
  geojson: null,
  selectedAgs: null,
  metric: "perCapita",
  source: "total",
  sortKey: "rankMetric",
  sortDirection: "desc",
  pathByAgs: new Map()
};

const els = {
  dataStatus: document.getElementById("dataStatus"),
  map: document.getElementById("districtMap"),
  tooltip: document.getElementById("mapTooltip"),
  sourceSelect: document.getElementById("sourceSelect"),
  metricSelect: document.getElementById("metricSelect"),
  districtSearch: document.getElementById("districtSearch"),
  districtOptions: document.getElementById("districtOptions"),
  selectedState: document.getElementById("selectedState"),
  selectedName: document.getElementById("selectedName"),
  selectedMeta: document.getElementById("selectedMeta"),
  selectedTotal: document.getElementById("selectedTotal"),
  selectedPerCapita: document.getElementById("selectedPerCapita"),
  sourceBars: document.getElementById("sourceBars"),
  qualityNote: document.getElementById("qualityNote"),
  rankingTitle: document.getElementById("rankingTitle"),
  rankingMeta: document.getElementById("rankingMeta"),
  rankingRows: document.getElementById("rankingRows"),
  rankingTable: document.querySelector(".table-panel table"),
  sourceCount: document.getElementById("sourceCount"),
  sourceList: document.getElementById("sourceList")
};

init();

async function init() {
  wireControls();
  const [summary, geojson] = await Promise.all([
    fetch("public/renewables/summary.json").then(response => response.json()),
    fetch("public/renewables/districts.geojson").then(response => response.json())
  ]);
  state.summary = summary;
  state.geojson = geojson;
  state.selectedAgs = topDistrict().ags;
  renderStaticContent();
  renderMap();
  render();
  window.addEventListener("resize", debounce(() => {
    renderMap();
    render();
  }, 120));
}

function wireControls() {
  els.sourceSelect.addEventListener("change", event => {
    state.source = event.target.value;
    render();
  });
  els.metricSelect.addEventListener("change", event => {
    state.metric = event.target.value;
    render();
  });
  els.rankingTable.addEventListener("click", event => {
    const button = event.target.closest("th button");
    if (!button) return;
    const th = button.closest("th");
    setSort(th.dataset.sort);
  });
  els.districtSearch.addEventListener("input", () => selectSearchMatch(false));
  els.districtSearch.addEventListener("change", () => selectSearchMatch(true));
  els.districtSearch.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      selectSearchMatch(true);
    }
  });
}

function setSort(sortKey) {
  if (state.sortKey === sortKey) {
    state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = sortKey;
    state.sortDirection = sortKey === "name" || sortKey === "state" ? "asc" : "desc";
  }
  renderRanking();
}

function selectSearchMatch(allowPartial) {
  const query = els.districtSearch.value.trim().toLocaleLowerCase("de-DE");
  if (!query) return;
  const exact = districts().find(district => district.name.toLocaleLowerCase("de-DE") === query);
  const partial = allowPartial
    ? districts().find(district => district.name.toLocaleLowerCase("de-DE").includes(query))
    : null;
  const match = exact || partial;
  if (match) {
    selectDistrict(match.ags);
  }
}

function renderStaticContent() {
  const meta = state.summary.metadata;
  els.dataStatus.textContent = `${meta.status}: ${meta.warning}`;
  els.districtOptions.innerHTML = districts()
    .map(district => `<option value="${escapeHtml(district.name)}"></option>`)
    .join("");
  els.sourceCount.textContent = `${meta.sources.length} Quellen`;
  els.sourceList.innerHTML = meta.sources
    .map(source => `
      <article class="source-item">
        <strong>${escapeHtml(source.title)}</strong>
        <small>${escapeHtml(source.source_type)} | ${escapeHtml(source.date || "")}</small>
        <p>${escapeHtml(source.notes)}</p>
        <a href="${source.url}" target="_blank" rel="noreferrer">Quelle öffnen</a>
      </article>
    `)
    .join("");
}

function renderMap() {
  const box = els.map.getBoundingClientRect();
  const width = Math.max(320, box.width || 900);
  const height = Math.max(520, box.height || 720);
  const bounds = geoBounds(state.geojson.features);
  const project = createProjection(bounds, width, height);

  els.map.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.map.innerHTML = "";
  state.pathByAgs.clear();

  const background = svg("rect", {
    x: 0,
    y: 0,
    width,
    height,
    fill: "#f8faf7"
  });
  els.map.append(background);

  for (const feature of state.geojson.features) {
    const path = svg("path", {
      d: featurePath(feature.geometry, project),
      class: "district",
      tabindex: "0",
      role: "button",
      "aria-label": feature.properties.name,
      "data-ags": feature.properties.ags
    });
    path.addEventListener("click", () => selectDistrict(feature.properties.ags));
    path.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectDistrict(feature.properties.ags);
      }
    });
    path.addEventListener("mousemove", event => showTooltip(event, feature.properties));
    path.addEventListener("mouseleave", hideTooltip);
    els.map.append(path);
    if (!state.pathByAgs.has(feature.properties.ags)) {
      state.pathByAgs.set(feature.properties.ags, []);
    }
    state.pathByAgs.get(feature.properties.ags).push(path);
  }
}

function render() {
  if (!state.summary || !state.geojson) return;
  renderMapColors();
  renderDetail();
  renderRanking();
}

function renderMapColors() {
  const values = state.geojson.features.map(feature => valueFor(feature.properties));
  const sorted = values.slice().sort((a, b) => a - b);
  const min = quantile(sorted, 0.03);
  const max = quantile(sorted, 0.97);

  for (const feature of state.geojson.features) {
    const ags = feature.properties.ags;
    const paths = state.pathByAgs.get(ags) || [];
    const t = normalize(valueFor(feature.properties), min, max);
    const fill = colorRamp(t, state.source);
    for (const path of paths) {
      path.setAttribute("fill", fill);
      path.classList.toggle("selected", ags === state.selectedAgs);
    }
  }
}

function renderDetail() {
  const selected = generationRows().find(row => row.ags === state.selectedAgs) || topDistrict();
  const district = districts().find(item => item.ags === selected.ags);
  els.districtSearch.value = district.name;
  els.selectedState.textContent = district.state_name;
  els.selectedName.textContent = district.name;
  els.selectedMeta.textContent = `${formatInteger(district.population)} Einwohner | ${formatNumber(district.area_km2, 0)} km² | ${district.district_type}`;
  els.selectedTotal.textContent = `${formatNumber(selected.total_gwh, 1)} GWh`;
  els.selectedPerCapita.textContent = `${formatNumber(selected.kwh_per_capita, 0)} kWh/EW`;
  els.qualityNote.textContent = `${selected.quality}: ${selected.audit_note}`;

  const sources = sourceValues(selected);
  const max = Math.max(...sources.map(item => item.value), 1);
  els.sourceBars.innerHTML = sources
    .map(item => `
      <div class="bar-row">
        <div class="bar-label">
          <span>${item.label}</span>
          <span>${formatNumber(item.value, 1)} GWh</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.max(2, item.value / max * 100)}%;background:${item.color}"></div>
        </div>
      </div>
    `)
    .join("");
}

function renderRanking() {
  updateSortHeaders();
  const rows = generationRows()
    .slice()
    .sort(compareRows);
  const districtByAgs = new Map(districts().map(district => [district.ags, district]));

  els.rankingTitle.textContent = `Landkreise: ${SOURCE_LABELS[state.source]}`;
  els.rankingMeta.textContent = `${sortLabel(state.sortKey)}, ${state.sortDirection === "asc" ? "aufsteigend" : "absteigend"}`;
  els.rankingRows.innerHTML = rows
    .map((row, index) => {
      const district = districtByAgs.get(row.ags);
      return `
        <tr data-ags="${row.ags}">
          <td>${index + 1}</td>
          <td>${escapeHtml(district.name)}</td>
          <td>${escapeHtml(district.state_name)}</td>
          <td>${formatNumber(row.solar_gwh, 1)}</td>
          <td>${formatNumber(row.wind_gwh, 1)}</td>
          <td>${formatNumber(row.biomass_gwh, 1)}</td>
          <td>${formatNumber(row.water_gwh, 1)}</td>
          <td>${formatNumber(row.kwh_per_capita, 0)}</td>
          <td>${escapeHtml(row.quality)}</td>
        </tr>
      `;
    })
    .join("");

  for (const row of els.rankingRows.querySelectorAll("tr")) {
    row.addEventListener("click", () => selectDistrict(row.dataset.ags));
  }
}

function updateSortHeaders() {
  for (const th of els.rankingTable.querySelectorAll("th[data-sort]")) {
    const active = th.dataset.sort === state.sortKey;
    th.setAttribute("aria-sort", active ? (state.sortDirection === "asc" ? "ascending" : "descending") : "none");
  }
}

function compareRows(a, b) {
  const direction = state.sortDirection === "asc" ? 1 : -1;
  const aValue = sortValue(a, state.sortKey);
  const bValue = sortValue(b, state.sortKey);
  if (typeof aValue === "string" || typeof bValue === "string") {
    return String(aValue).localeCompare(String(bValue), "de-DE") * direction;
  }
  if (aValue === bValue) {
    return sortValue(a, "name").localeCompare(sortValue(b, "name"), "de-DE");
  }
  return (aValue - bValue) * direction;
}

function sortValue(row, sortKey) {
  const district = districts().find(item => item.ags === row.ags);
  if (sortKey === "rankMetric") return rankingValue(row);
  if (sortKey === "name") return district.name;
  if (sortKey === "state") return district.state_name;
  if (sortKey === "perCapita") return row.kwh_per_capita;
  if (sortKey === "solar") return row.solar_gwh;
  if (sortKey === "wind") return row.wind_gwh;
  if (sortKey === "biomass") return row.biomass_gwh;
  if (sortKey === "water") return row.water_gwh;
  if (sortKey === "quality") return row.quality;
  return 0;
}

function sortLabel(sortKey) {
  const labels = {
    rankMetric: state.metric === "perCapita" ? "aktuelle Kartenkennzahl" : "aktuelle Quellenmenge",
    name: "Landkreis",
    state: "Bundesland",
    solar: "Solar GWh",
    wind: "Wind GWh",
    biomass: "Biomasse GWh",
    water: "Wasser GWh",
    perCapita: "kWh pro Einwohner",
    quality: "Qualität"
  };
  return labels[sortKey] || sortKey;
}

function selectDistrict(ags) {
  state.selectedAgs = ags;
  render();
}

function showTooltip(event, props) {
  els.tooltip.hidden = false;
  els.tooltip.innerHTML = `
    <strong>${escapeHtml(props.name)}</strong>
    ${formatNumber(valueFor(props), state.metric === "perCapita" ? 0 : 1)}
    ${state.metric === "perCapita" ? "kWh/EW" : "GWh"}
  `;
  const panelRect = event.currentTarget.ownerSVGElement.parentElement.getBoundingClientRect();
  els.tooltip.style.left = `${event.clientX - panelRect.left + 14}px`;
  els.tooltip.style.top = `${event.clientY - panelRect.top + 14}px`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

function valueFor(props) {
  if (state.metric === "perCapita") {
    if (state.source === "total") return props.kwh_per_capita;
    return props[`${state.source}_gwh`] * 1000000 / props.population;
  }
  if (state.source === "total") return props.total_gwh;
  return props[`${state.source}_gwh`];
}

function rankingValue(row) {
  if (state.metric === "perCapita") {
    if (state.source === "total") return row.kwh_per_capita;
    const district = districts().find(item => item.ags === row.ags);
    return row[`${state.source}_gwh`] * 1000000 / district.population;
  }
  if (state.source === "total") return row.total_gwh;
  return row[`${state.source}_gwh`];
}

function sourceValues(row) {
  return [
    { id: "solar", label: "Solar", value: row.solar_gwh, color: SOURCE_COLORS.solar },
    { id: "wind", label: "Wind", value: row.wind_gwh, color: SOURCE_COLORS.wind },
    { id: "biomass", label: "Biomasse", value: row.biomass_gwh, color: SOURCE_COLORS.biomass },
    { id: "water", label: "Wasser", value: row.water_gwh, color: SOURCE_COLORS.water }
  ];
}

function topDistrict() {
  return generationRows().slice().sort((a, b) => b.kwh_per_capita - a.kwh_per_capita)[0];
}

function districts() {
  return state.summary?.districts || [];
}

function generationRows() {
  return state.summary?.generation || [];
}

function geoBounds(features) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of features) {
    visitCoordinates(feature.geometry.coordinates, coord => {
      bounds[0] = Math.min(bounds[0], coord[0]);
      bounds[1] = Math.min(bounds[1], coord[1]);
      bounds[2] = Math.max(bounds[2], coord[0]);
      bounds[3] = Math.max(bounds[3], coord[1]);
    });
  }
  return bounds;
}

function createProjection(bounds, width, height) {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const padding = Math.min(width, height) * 0.045;
  const scale = Math.min((width - padding * 2) / (maxLon - minLon), (height - padding * 2) / (maxLat - minLat));
  const xOffset = (width - (maxLon - minLon) * scale) / 2;
  const yOffset = (height - (maxLat - minLat) * scale) / 2;
  return ([lon, lat]) => [
    xOffset + (lon - minLon) * scale,
    height - (yOffset + (lat - minLat) * scale)
  ];
}

function featurePath(geometry, project) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .map(polygon => polygon
      .map(ring => ring
        .map((coord, index) => {
          const [x, y] = project(coord);
          return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join("") + "Z")
      .join(""))
    .join("");
}

function visitCoordinates(coords, visitor) {
  if (typeof coords[0] === "number") {
    visitor(coords);
    return;
  }
  for (const coord of coords) {
    visitCoordinates(coord, visitor);
  }
}

function colorRamp(t, source) {
  const palettes = {
    total: [[236, 242, 231], [33, 120, 90], [10, 79, 59]],
    solar: [[250, 242, 221], [204, 138, 30], [130, 79, 10]],
    wind: [[225, 236, 244], [53, 111, 149], [26, 72, 103]],
    biomass: [[228, 240, 229], [33, 120, 90], [18, 84, 59]],
    water: [[225, 240, 246], [79, 143, 183], [38, 92, 128]]
  };
  const colors = palettes[source] || palettes.total;
  const a = t < 0.62 ? colors[0] : colors[1];
  const b = t < 0.62 ? colors[1] : colors[2];
  const localT = t < 0.62 ? t / 0.62 : (t - 0.62) / 0.38;
  return `rgb(${mix(a[0], b[0], localT)}, ${mix(a[1], b[1], localT)}, ${mix(a[2], b[2], localT)})`;
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function normalize(value, min, max) {
  if (max <= min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function quantile(sorted, q) {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function svg(tagName, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

function formatInteger(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
