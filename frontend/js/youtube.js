// YouTube account linking (Settings screen).
//
// The player is a YouTube IFrame embed, so it is signed in via Chromium's
// youtube.com cookies — not via any API token. The only phone-scannable flow
// that produces those cookies is the TV pairing screen, which the backend opens
// in this same browser profile. See kiosk/youtube-signin.sh.
import { api } from "./api.js";

const stateEl = () => document.getElementById("yt-acct-state");
const noteEl = () => document.getElementById("yt-signin-state");

export async function refreshAccount() {
  const el = stateEl();
  if (!el) return;
  try {
    const s = await api.yt.account();
    if (s.signedIn) {
      el.textContent = "Signed in";
      el.style.color = "var(--accent-2)";
    } else if (s.known) {
      el.textContent = "Not signed in";
      el.style.color = "var(--muted)";
    } else {
      // Cookie store locked or absent — say so rather than claim "signed out".
      el.textContent = "Unknown";
      el.style.color = "var(--muted)";
    }
  } catch (_) {
    el.textContent = "Unavailable";
    el.style.color = "var(--muted)";
  }
}

export function initYouTubeAccount() {
  const btn = document.getElementById("yt-signin");
  btn?.addEventListener("click", async () => {
    if (!confirm(
      "The dashboard will close for a moment and reopen on the YouTube pairing "
      + "screen.\n\nLink it from the YouTube app on your phone, then tap the ✕ "
      + "on that window to return here.\n\nContinue?")) return;
    noteEl() && (noteEl().textContent = "Opening pairing screen…");
    try {
      const r = await api.yt.signin();
      if (!r.ok) noteEl().textContent = "Couldn't start: " + (r.error || "unknown");
    } catch (_) {
      // Expected: the browser is being closed out from under this request.
      noteEl() && (noteEl().textContent = "Opening…");
    }
  });
  refreshAccount();
}
