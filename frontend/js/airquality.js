// Air Quality & Pollen view, via the backend's Open-Meteo Air Quality proxy
// (same free, no-key API family as the Weather view).
import { api } from "./api.js";

const $ = (id) => document.getElementById(id);

// US AQI breakpoints.
function aqiLabel(v) {
  if (v == null) return ["—", "unknown"];
  if (v <= 50) return ["Good", "good"];
  if (v <= 100) return ["Moderate", "moderate"];
  if (v <= 150) return ["Unhealthy (sensitive groups)", "sensitive"];
  if (v <= 200) return ["Unhealthy", "unhealthy"];
  if (v <= 300) return ["Very unhealthy", "very-unhealthy"];
  return ["Hazardous", "hazardous"];
}

// Pollen coverage is Open-Meteo's CAMS European model -- only Europe gets
// real values elsewhere the API just returns null, shown as "unavailable".
const POLLENS = [
  ["grass_pollen", "Grass"], ["ragweed_pollen", "Ragweed"], ["birch_pollen", "Birch"],
  ["alder_pollen", "Alder"], ["mugwort_pollen", "Mugwort"], ["olive_pollen", "Olive"],
];

function round(n) { return n == null ? "—" : Math.round(n); }

export async function loadAirQuality() {
  const wrap = $("aq-body");
  if (!wrap) return;
  wrap.innerHTML = '<div class="muted">Loading…</div>';
  let data;
  try {
    data = await api.airQuality();
  } catch (_) {
    wrap.innerHTML = '<div class="muted">Couldn\'t reach the backend.</div>';
    return;
  }
  if (data.error) {
    wrap.innerHTML = `<div class="muted">${data.error}</div>`;
    return;
  }
  const c = data.current || {};
  const [label, cls] = aqiLabel(c.us_aqi);
  const hourly = data.hourly || {};
  const hIdx = 0; // first hourly entry lines up with "now"

  const pollenRows = POLLENS.map(([key, name]) => {
    const series = hourly[key];
    const val = series ? series[hIdx] : null;
    return `<div class="aq-pollen-row"><span>${name}</span>` +
      `<span>${val == null ? "—" : round(val) + " µg/m³"}</span></div>`;
  }).join("");
  const anyPollen = POLLENS.some(([key]) => hourly[key] && hourly[key][hIdx] != null);

  wrap.innerHTML = `
    <div class="aq-current aq-${cls}">
      <div class="aq-aqi">${round(c.us_aqi)}</div>
      <div class="aq-aqi-label">${label}</div>
      <div class="muted small">US AQI</div>
    </div>
    <div class="aq-metrics">
      <div>PM2.5<b>${round(c.pm2_5)}</b></div>
      <div>PM10<b>${round(c.pm10)}</b></div>
      <div>Ozone<b>${round(c.ozone)}</b></div>
      <div>UV Index<b>${round(c.uv_index)}</b></div>
    </div>
    <h2 class="sub-h">Pollen</h2>
    <div class="aq-pollen">${anyPollen ? pollenRows :
      '<div class="muted">Pollen data isn\'t available for this location.</div>'}</div>
  `;
}

export function initAirQuality() {
  $("aq-refresh")?.addEventListener("click", loadAirQuality);
}
