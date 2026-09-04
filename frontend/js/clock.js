// Clock for the top bar and the Home hero, driven by settings.
import { store } from "./store.js";

const topEl = () => document.getElementById("top-clock");
const homeTime = () => document.getElementById("home-clock");
const homeDate = () => document.getElementById("home-date");

function render() {
  const s = store.get();
  const clk = (s && s.clock) || { format24h: false, showSeconds: true, showDate: true };
  const now = new Date();

  const timeOpts = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: !clk.format24h,
  };
  if (clk.showSeconds) timeOpts.second = "2-digit";
  const timeStr = now.toLocaleTimeString([], timeOpts);

  const dateStr = now.toLocaleDateString([], {
    weekday: "long", month: "long", day: "numeric",
  });

  if (topEl()) topEl().textContent = now.toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", hour12: !clk.format24h,
  });
  if (homeTime()) homeTime().textContent = timeStr;
  if (homeDate()) homeDate().textContent = clk.showDate ? dateStr : "";
}

export function startClock() {
  render();
  setInterval(render, 1000);
  store.subscribe(render);
}
