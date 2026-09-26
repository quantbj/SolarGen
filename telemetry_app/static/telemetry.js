const $ = (id) => document.getElementById(id);

function percent(value) { return Number.isFinite(value) ? `${Math.round(value)}%` : "—"; }
function temp(value) { return Number.isFinite(value) ? `${value.toFixed(1)}°C` : "—"; }
function rate(value) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value < 10 && index ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}
function severity(element, value, warning, danger) {
  element.classList.toggle("warning", value >= warning && value < danger);
  element.classList.toggle("danger", value >= danger);
}

function updateCurrent(data) {
  if (!data.recorded_at) return;
  $("cpu").textContent = percent(data.cpu_percent);
  $("memory").textContent = percent(data.memory_percent);
  $("disk").textContent = percent(data.disk_percent);
  $("cpuGauge").style.width = `${Math.min(100, data.cpu_percent)}%`;
  $("memoryGauge").style.width = `${Math.min(100, data.memory_percent)}%`;
  $("diskGauge").style.width = `${Math.min(100, data.disk_percent)}%`;
  $("cpuDetail").textContent = `${percent(data.cpu_load_1m)} normalized 1-minute load`;
  $("cpuTemp").textContent = temp(data.cpu_temperature_c);
  $("temperatureNote").textContent = data.cpu_temperature_c == null ? "Sensor helper not configured" : "Optional CPU sensor reading";
  $("thermal").textContent = data.thermal_pressure;
  $("diskIo").textContent = rate(data.disk_activity_bps);
  $("battery").textContent = percent(data.battery_percent);
  $("batteryDetail").textContent = data.battery_state;
  $("batteryTemp").textContent = temp(data.battery_temperature_c);
  $("lastUpdated").textContent = new Date(data.recorded_at * 1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
  severity($("memory"), data.memory_percent, 85, 95);
  severity($("disk"), data.disk_percent, 85, 92);
  severity($("batteryTemp"), data.battery_temperature_c ?? 0, 35, 42);
  $("thermal").classList.toggle("danger", ["Heavy", "Critical"].includes(data.thermal_pressure));
  $("thermal").classList.toggle("warning", data.thermal_pressure === "Moderate");
}

function path(points, key) {
  if (!points.length) return "";
  const first = points[0].recorded_at;
  const span = Math.max(1, points.at(-1).recorded_at - first);
  return points.map((point, index) => {
    const x = 52 + (point.recorded_at - first) / span * 890;
    const y = 20 + (100 - Math.max(0, Math.min(100, point[key]))) / 100 * 240;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function drawChart(points) {
  const svg = $("chart");
  $("emptyChart").style.display = points.length < 2 ? "block" : "none";
  const cpu = path(points, "cpu_percent");
  const memory = path(points, "memory_percent");
  const area = cpu ? `${cpu} L942,260 L52,260 Z` : "";
  const grid = [0,25,50,75,100].map((value) => {
    const y = 260 - value * 2.4;
    return `<line class="grid-line" x1="52" y1="${y}" x2="942" y2="${y}"/><text class="axis-label" x="4" y="${y + 4}">${value}%</text>`;
  }).join("");
  const labels = points.length ? `<text class="axis-label" x="52" y="288">${new Date(points[0].recorded_at*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</text><text class="axis-label" x="900" y="288">Now</text>` : "";
  svg.innerHTML = `${grid}<path class="area" d="${area}"/><path class="line" d="${cpu}"/><path class="line memory" d="${memory}"/>${labels}`;
}

async function refresh() {
  const hours = $("range").value;
  try {
    const [currentResponse, historyResponse] = await Promise.all([fetch("/api/current"), fetch(`/api/history?hours=${hours}`)]);
    updateCurrent(await currentResponse.json());
    drawChart(await historyResponse.json());
  } catch (error) {
    $("lastUpdated").textContent = "Disconnected";
  }
}

$("range").addEventListener("change", () => {
  $("rangeLabel").textContent = `Last ${$("range").selectedOptions[0].textContent}`;
  refresh();
});
refresh();
setInterval(refresh, 5000);
