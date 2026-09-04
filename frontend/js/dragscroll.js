// Finger drag-to-scroll for the content pane.
//
// Why this exists: this panel's touches reach Chromium as emulated *pointer*
// events rather than wl_touch, so the browser's native touch panning never
// engages — taps worked but dragging did nothing, while a synthetic touch swipe
// scrolled fine. Rather than depend on how the compositor happens to deliver
// input, we drive scrolling ourselves from Pointer Events (which fire for touch,
// pen and mouse alike) and set `touch-action: none` so nothing double-scrolls.
const THRESHOLD = 8;      // px before a press becomes a drag (keeps taps working)
// A finger pressing a button drifts several px before lifting, and at 8px that
// counted as a drag — which swallowed the tap and made buttons look dead. Presses
// that start on a control get a much larger threshold, so drag-scrolling still
// works from anywhere but a sloppy tap stays a tap.
const CONTROL_THRESHOLD = 26;
const CONTROLS = 'button, a, input, select, textarea, label, [role="button"], [data-act]';
const FRICTION = 0.94;    // momentum decay per frame
const MIN_VELOCITY = 0.02; // px/ms below which momentum stops

export function initDragScroll(el) {
  if (!el) return;

  let pointerId = null;
  let startY = 0, startTop = 0;
  let threshold = THRESHOLD;
  let dragging = false;
  let lastY = 0, lastT = 0, velocity = 0;
  let glideId = null;

  const stopGlide = () => {
    if (glideId !== null) { cancelAnimationFrame(glideId); glideId = null; }
  };

  const swallowClick = (e) => { e.stopPropagation(); e.preventDefault(); };

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopGlide();
    pointerId = e.pointerId;
    threshold = e.target?.closest?.(CONTROLS) ? CONTROL_THRESHOLD : THRESHOLD;
    startY = lastY = e.clientY;
    startTop = el.scrollTop;
    lastT = e.timeStamp;
    velocity = 0;
    dragging = false;
  }

  function onMove(e) {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < threshold) return;
      dragging = true;
      try { el.setPointerCapture(pointerId); } catch (_) { /* not critical */ }
    }
    el.scrollTop = startTop - dy;

    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;   // px per ms
    lastY = e.clientY;
    lastT = e.timeStamp;
    e.preventDefault();
  }

  function glide() {
    velocity *= FRICTION;
    if (Math.abs(velocity) < MIN_VELOCITY) { glideId = null; return; }
    const before = el.scrollTop;
    el.scrollTop = before - velocity * 16;            // ~one frame of travel
    if (el.scrollTop === before) { glideId = null; return; }  // hit an edge
    glideId = requestAnimationFrame(glide);
  }

  function onUp(e) {
    if (pointerId === null || (e.pointerId !== undefined && e.pointerId !== pointerId)) return;
    const wasDragging = dragging;
    try { el.releasePointerCapture(pointerId); } catch (_) { /* fine */ }
    pointerId = null;
    dragging = false;
    // Only steal the click if the drag actually scrolled something. A press that
    // crossed the threshold but moved nothing (already at an edge) was a tap as
    // far as the user is concerned.
    if (wasDragging && el.scrollTop !== startTop) {
      // A drag must not also register as a tap on whatever was under the finger.
      el.addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => el.removeEventListener("click", swallowClick, true), 350);
      if (Math.abs(velocity) >= MIN_VELOCITY) glideId = requestAnimationFrame(glide);
    }
  }

  el.addEventListener("pointerdown", onDown, { passive: true });
  el.addEventListener("pointermove", onMove, { passive: false });
  el.addEventListener("pointerup", onUp, { passive: true });
  el.addEventListener("pointercancel", onUp, { passive: true });
  el.addEventListener("pointerleave", onUp, { passive: true });
  // A stray wheel/native scroll should cancel momentum rather than fight it.
  el.addEventListener("wheel", stopGlide, { passive: true });
}
