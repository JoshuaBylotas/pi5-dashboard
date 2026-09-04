// Dashboard chrome for the YouTube TV app.
//
// Why the TV app is the *top-level* page rather than an iframe inside the
// dashboard: framed, youtube.com is a third-party context, where localStorage
// throws SecurityError and the leanback app dies on its splash — the phone
// sign-in is invisible to it. Top-level it is first-party, so the account that
// was linked by QR just works. The cost is that the shell has to be injected
// here instead of wrapping the page, which is what this file does.
(() => {
  "use strict";

  const DASH = "http://127.0.0.1:8080/";
  const RAIL = [
    { icon: "\u{1F3E0}", label: "Home", view: "home" },
    { icon: "\u{1F3B5}", label: "Music", view: null },      // this page
    { icon: "\u{26C5}", label: "Weather", view: "weather" },
    { icon: "\u{2699}\u{FE0F}", label: "Settings", view: "settings" },
  ];

  if (document.getElementById("pi5-rail")) return;   // already injected

  // --- inset the app -------------------------------------------------------
  // Move the app's existing content into a transformed stage so its `fixed`
  // elements are confined beside the rail instead of under it.
  const stage = document.createElement("div");
  stage.id = "pi5-stage";
  while (document.body.firstChild) stage.appendChild(document.body.firstChild);
  document.body.appendChild(stage);

  // The SPA appends new nodes straight to <body>; they must go in the stage too,
  // or they escape the inset and sit under the rail.
  new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node === stage || node.id === "pi5-rail" || node.id === "pi5-dpad") continue;
        if (node.parentNode === document.body) stage.appendChild(node);
      }
    }
  }).observe(document.body, { childList: true });

  // No on-screen D-pad here on purpose. leanback ignores untrusted events, so
  // synthetic KeyboardEvents from this content script do nothing (measured: a
  // synthetic ArrowRight left the focus ring put, while a real one moved it).
  // Touching the panel produces trusted events and does drive the app, so taps
  // are the navigation. Arrow buttons would need real key injection at the
  // compositor (wtype) or via a debug port — neither is installed.

  // --- rail ----------------------------------------------------------------
  const rail = document.createElement("div");
  rail.id = "pi5-rail";
  RAIL.forEach((item) => {
    const b = document.createElement("button");
    b.className = "pi5-nav" + (item.view === null ? " active" : "");
    b.innerHTML = `<span>${item.icon}</span>${item.label}`;
    if (item.view !== null) {
      b.addEventListener("click", () => {
        location.href = `${DASH}?view=${item.view}`;
      });
    }
    rail.appendChild(b);
  });
  const spacer = document.createElement("div");
  spacer.className = "pi5-spacer";
  rail.appendChild(spacer);
  const close = document.createElement("button");
  close.className = "pi5-nav pi5-close";
  close.innerHTML = "<span>⏻</span>Back";
  close.addEventListener("click", () => { location.href = DASH; });
  rail.appendChild(close);
  document.body.appendChild(rail);
})();
