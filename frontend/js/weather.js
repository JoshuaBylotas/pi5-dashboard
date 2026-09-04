// Weather view + Home summary, powered by the backend Open-Meteo proxy.
import { api } from "./api.js";

// WMO weather code → { label, emoji }. Day/night handled by caller for clear sky.
const WMO = {
  0: ["Clear", "☀️"], 1: ["Mainly clear", "🌤️"], 2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁️"], 45: ["Fog", "🌫️"], 48: ["Rime fog", "🌫️"],
  51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Heavy drizzle", "🌦️"],
  56: ["Freezing drizzle", "🌧️"], 57: ["Freezing drizzle", "🌧️"],
  61: ["Light rain", "🌧️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"],
  71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "🌨️"], 80: ["Showers", "🌦️"], 81: ["Showers", "🌦️"],
  82: ["Violent showers", "⛈️"], 85: ["Snow showers", "🌨️"], 86: ["Snow showers", "🌨️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm + hail", "⛈️"], 99: ["Thunderstorm + hail", "⛈️"],
};

function decode(code, isDay = 1) {
  const [label, emoji] = WMO[code] || ["—", "🌡️"];
  if (code === 0 && !isDay) return [label, "🌙"];
  if (code === 1 && !isDay) return [label, "🌙"];
  return [label, emoji];
}

const $ = (id) => document.getElementById(id);
let cache = null;

export async function loadWeather() {
  try {
    const data = await api.weather();
    if (data.error) throw new Error(data.error);
    cache = data;
    renderCurrent(data);
    renderForecast(data);
    renderHome(data);
    setNet(true);
  } catch (e) {
    console.error("weather", e);
    setNet(false);
    if ($("home-wx-desc")) $("home-wx-desc").textContent = "Weather unavailable";
    if ($("wx-big-desc")) $("wx-big-desc").textContent = "Weather unavailable";
  }
}

function unitDeg(data) {
  return (data.current_units && data.current_units.temperature_2m) || "°";
}

function renderCurrent(data) {
  const c = data.current || {};
  const [label, emoji] = decode(c.weather_code, c.is_day);
  const deg = unitDeg(data);
  $("wx-big-icon").textContent = emoji;
  $("wx-big-temp").textContent = `${Math.round(c.temperature_2m)}${deg}`;
  $("wx-big-desc").textContent = label;
  $("wx-place").textContent = (data._location && data._location.name) || "";
  $("wx-feels").textContent = `${Math.round(c.apparent_temperature)}${deg}`;
  $("wx-humidity").textContent = `${Math.round(c.relative_humidity_2m)}%`;
  const windU = (data.current_units && data.current_units.wind_speed_10m) || "";
  $("wx-wind").textContent = `${Math.round(c.wind_speed_10m)} ${windU}`;
}

function renderHome(data) {
  const c = data.current || {};
  const [label, emoji] = decode(c.weather_code, c.is_day);
  const deg = unitDeg(data);
  if ($("home-wx-icon")) $("home-wx-icon").textContent = emoji;
  if ($("home-wx-temp")) $("home-wx-temp").textContent = `${Math.round(c.temperature_2m)}${deg}`;
  if ($("home-wx-desc")) $("home-wx-desc").textContent = label;
  if ($("home-wx-place")) $("home-wx-place").textContent =
    (data._location && data._location.name) || "";
}

function renderForecast(data) {
  const d = data.daily;
  const wrap = $("wx-forecast");
  if (!d || !wrap) return;
  const deg = (data.daily_units && data.daily_units.temperature_2m_max) || "°";
  wrap.innerHTML = "";
  d.time.forEach((iso, i) => {
    const day = new Date(iso + "T00:00:00");
    const [, emoji] = decode(d.weather_code[i]);
    const name = i === 0 ? "Today"
      : day.toLocaleDateString([], { weekday: "short" });
    const pop = d.precipitation_probability_max[i];
    const el = document.createElement("div");
    el.className = "wx-day";
    el.innerHTML =
      `<div class="d">${name}</div>` +
      `<div class="i">${emoji}</div>` +
      `<div><span class="hi">${Math.round(d.temperature_2m_max[i])}${deg}</span> ` +
      `<span class="lo">${Math.round(d.temperature_2m_min[i])}${deg}</span></div>` +
      (pop != null ? `<div class="pop">💧 ${pop}%</div>` : "");
    wrap.appendChild(el);
  });
}

function setNet(ok) {
  const el = document.getElementById("net-indicator");
  if (el) el.classList.toggle("off", !ok);
}

export function initWeather() {
  const btn = document.getElementById("wx-refresh");
  if (btn) btn.addEventListener("click", loadWeather);
  loadWeather();
  setInterval(loadWeather, 10 * 60 * 1000); // refresh every 10 min
}
