// PocketRocket site: the hero's orbit layer. No framework, no build step; index.html only.
// The room card is the planet. The bots circle it on tilted orbits; now and then one hands work to
// another (a pulse along a curved line), and one pulse stops at the approval checkpoint beside the
// card's approval card: amber until the tick. The first cycle is timed to the card's CSS beats
// (styles.css, .room .b1 to .b5). The pointer tilts the orbital plane a little.
// Decorative only (the canvas is aria-hidden). Reduced motion draws one still frame. The loop stops
// while the tab is hidden or the hero is off-screen; layout is read on resize only, never per frame.
(function () {
  var stage = document.querySelector(".hero-stage");
  var canvas = stage && stage.querySelector(".orbit");
  var card = stage && stage.querySelector(".room");
  var ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx || !card) return;
  var approval = card.querySelector(".approval");
  var copy = stage.querySelector(".hero-copy");
  var root = document.documentElement;
  var mq = function (q) { return window.matchMedia ? matchMedia(q) : { matches: false }; };
  var reduce = mq("(prefers-reduced-motion: reduce)");
  var fine = mq("(hover: hover) and (pointer: fine)");
  var TAU = Math.PI * 2, RAD = Math.PI / 180;

  // Orbits: radius in units of the card's half width, on-screen roll in degrees.
  // Rolled so the near-left ends land in the open space beside the buttons, not behind the copy.
  var ORBITS = [{ r: 1.1, roll: -14 }, { r: 1.3, roll: -21 }, { r: 1.5, roll: -27 }, { r: 1.76, roll: -33, dash: 1 }];
  // Bots: orbit, period (s), start angle (deg; 180 = left, 90 = far side). L, C and W match the card.
  var SATS = [
    { o: 0, p: 56, a: 196, l: "L", tint: 1 },
    { o: 1, p: 44, a: 170, l: "C", tint: 2 },
    { o: 2, p: 70, a: 206, l: "W", tint: 3 },
    { o: 1, p: 44, a: 330 },
    { o: 3, p: 96, a: 140 },
    { o: 3, p: 96, a: 300, lite: 1 },
    { o: 2, p: 70, a: 40, lite: 1 }
  ];
  var STILL = 4.05; // the reduced-motion frame: both handoffs done, approval ticked

  var W, H, dpr, stacked, small, cx, cy, unit, planet, elev, cardBox, copyBoxes, check, enter, backdrop, C, dark;
  var tiltX = 0, tiltY = 0, aimX = 0, aimY = 0;
  var clock = 0, last = 0, raf = 0, onScreen = true, events = [];

  function css(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function readColors() {
    C = {};
    ["bg", "panel", "line2", "fg", "muted", "accent", "warn", "warn-soft", "ok", "tint-1", "tint-2", "tint-3"]
      .forEach(function (k) { C[k] = css("--" + k) || "#888888"; });
    dark = parseInt(C.bg.slice(1, 3), 16) < 128;
  }
  function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }
  function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function layout() {
    W = stage.clientWidth; H = stage.clientHeight;
    if (!W || !H) return false;
    stacked = W < 980; small = W < 600;
    dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var s = stage.getBoundingClientRect(), r = card.getBoundingClientRect();
    var box = function (b) { return { x: b.left - s.left, y: b.top - s.top, w: b.width, h: b.height }; };
    cardBox = box(r); copyBoxes = [];
    // The copy's actual line boxes and buttons, so only real text pushes the bots back.
    if (copy) [].forEach.call(copy.children, function (el) {
      var rects = el.classList.contains("actions") ? [].map.call(el.children, function (b) { return b.getBoundingClientRect(); })
        : (function () { var rg = document.createRange(); rg.selectNodeContents(el); return rg.getClientRects(); })();
      [].forEach.call(rects, function (b) { if (b.width) copyBoxes.push(box(b)); });
    });
    cx = cardBox.x + cardBox.w / 2;
    if (stacked) {
      unit = Math.min(cardBox.w / 2, W * 0.27); cy = cardBox.y - 40; planet = unit * 0.82; elev = 24;
      check = { x: cardBox.x + cardBox.w - 44, y: cardBox.y - 24 }; enter = { x: cardBox.x + cardBox.w - 44, y: cardBox.y + 12 };
    } else {
      unit = cardBox.w / 2; cy = cardBox.y + cardBox.h * 0.46; planet = Math.max(cardBox.w, cardBox.h) * 0.6; elev = 20;
      var a = approval ? approval.getBoundingClientRect() : r;
      var ay = a.top - s.top + Math.min(a.height / 2, 40);
      check = { x: cardBox.x - 24, y: ay }; enter = { x: cardBox.x + 12, y: ay };
    }
    buildBackdrop();
    return true;
  }

  // Static texture, drawn once per resize or theme change: stars in the dark, a dot grid in the light.
  function buildBackdrop() {
    var m = 12, b = document.createElement("canvas");
    b.width = Math.round((W + m * 2) * dpr); b.height = Math.round((H + m * 2) * dpr);
    var g = b.getContext("2d"), rand = rng(7);
    g.scale(dpr, dpr);
    if (dark) {
      var n = Math.round(W * H / (small ? 3600 : 2200));
      for (var i = 0; i < n; i++) {
        var big = rand() < 0.08;
        g.fillStyle = rgba(big && rand() < 0.5 ? C.accent : C.fg, 0.2 + rand() * (big ? 0.6 : 0.45));
        g.beginPath(); g.arc(rand() * (W + m * 2), rand() * (H + m * 2), big ? 1.2 : 0.4 + rand() * 0.6, 0, TAU); g.fill();
      }
    } else {
      var step = small ? 22 : 26, reach = Math.max(W, H) * 0.75;
      for (var y = step / 2; y < H + m * 2; y += step) for (var x = step / 2; x < W + m * 2; x += step) {
        var d = Math.hypot(x - m - cx, y - m - cy), al = 0.8 * (1 - d / reach);
        if (al <= 0.02) continue;
        g.fillStyle = rgba(C.line2, al.toFixed(2)); g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
    backdrop = b;
  }

  // Project a point on an orbit (radius in px, angle in rad) to the screen: ring in a horizontal
  // plane, yawed and seen from `elev` degrees above, light perspective, then rolled on screen.
  function proj(R, th, roll) {
    var yaw = tiltX * 7 * RAD, e = (elev + tiltY * 5) * RAD;
    var X = R * Math.cos(th), Z = R * Math.sin(th);
    var X2 = X * Math.cos(yaw) + Z * Math.sin(yaw), Z2 = -X * Math.sin(yaw) + Z * Math.cos(yaw);
    var z = Z2 * Math.cos(e), k = 2000 / (2000 + z);
    // Stacked (phone) layout: the system rises above the card, so the rings tip the other way.
    var x = X2 * k, y = -Z2 * Math.sin(e) * k, rr = roll * (stacked ? -0.45 : 1) * RAD;
    return { x: cx + x * Math.cos(rr) - y * Math.sin(rr), y: cy + x * Math.sin(rr) + y * Math.cos(rr), z: z, k: k };
  }
  function satAt(i, t) {
    var s = SATS[i], o = ORBITS[s.o];
    return proj(o.r * unit, (s.a + 360 * t / s.p) * RAD, o.roll);
  }
  function active(i) { return !(small && SATS[i].lite); }
  function inside(p, b, m) { return p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m; }
  function hidden(p) { return inside(p, cardBox, 6) || p.x < 8 || p.x > W - 8 || p.y < 8 || p.y > H - 8; }
  // Behind the headline and buttons a bot fades back, so the copy always reads cleanly.
  function behindCopy(p) { for (var i = 0; i < copyBoxes.length; i++) if (inside(p, copyBoxes[i], 12)) return true; return false; }

  // The story, as a pure function of time so a still frame is just draw(STILL). The first three
  // events follow the card: Lead hands off to Coder and Writer, then Coder asks for approval.
  function eventAt(k) {
    if (events[k] !== undefined) return events[k];
    var ev = null;
    if (k === 0) ev = { t: 1.0, f: 0, to: 1 };
    else if (k === 1) ev = { t: 1.35, f: 0, to: 2 };
    else if (k === 2) ev = { t: 1.75, f: 1, check: 1 };
    else {
      var t = 6 + (k - 3) * 3.2, rand = rng(k * 9973 + 1), vis = [], tx = tiltX, ty = tiltY;
      tiltX = tiltY = 0; // choose from the resting pose, so the story never depends on the pointer
      for (var i = 0; i < SATS.length; i++) { var q = satAt(i, t); if (active(i) && !hidden(q) && !behindCopy(q)) vis.push(i); }
      tiltX = tx; tiltY = ty;
      if ((k - 3) % 3 === 2 && vis.length) ev = { t: t, f: vis[Math.floor(rand() * vis.length)], check: 1 };
      else if (vis.length > 1) {
        var a = Math.floor(rand() * vis.length), b = (a + 1 + Math.floor(rand() * (vis.length - 1))) % vis.length;
        ev = { t: t, f: vis[a], to: vis[b] };
      }
    }
    return (events[k] = ev);
  }

  function curve(a, b, u) {
    var dx = b.x - a.x, dy = b.y - a.y, bend = 0.24;
    var qx = (a.x + b.x) / 2 + dy * bend * (dx > 0 ? 1 : -1), qy = (a.y + b.y) / 2 - Math.abs(dx) * bend;
    var v = 1 - u;
    return { x: v * v * a.x + 2 * v * u * qx + u * u * b.x, y: v * v * a.y + 2 * v * u * qy + u * u * b.y };
  }
  function strokeCurve(a, b, u0, u1, color, width, dash) {
    ctx.beginPath(); ctx.setLineDash(dash || []);
    for (var i = 0; i <= 24; i++) { var p = curve(a, b, u0 + (u1 - u0) * i / 24); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
  }
  function pulse(a, b, u, alpha) {
    strokeCurve(a, b, 0, 1, rgba(C.accent, 0.28 * alpha), 1, [3, 4]);
    strokeCurve(a, b, Math.max(0, u - 0.22), u, rgba(C.accent, 0.75 * alpha), 2);
    var h = curve(a, b, u), g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, 11);
    g.addColorStop(0, rgba(C.accent, 0.5 * alpha)); g.addColorStop(1, rgba(C.accent, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h.x, h.y, 11, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(dark ? C.fg : C.accent, alpha); ctx.beginPath(); ctx.arc(h.x, h.y, 2.6, 0, TAU); ctx.fill();
  }
  function ring(p, r, color, w) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(); }

  function drawPlanet() {
    var g = ctx.createRadialGradient(cx - planet * 0.35, cy - planet * 0.4, planet * 0.1, cx, cy, planet);
    g.addColorStop(0, rgba(C["tint-1"], dark ? 0.95 : 0.9));
    g.addColorStop(1, rgba(dark ? C.bg : C["tint-1"], dark ? 0.6 : 0.25));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, planet, 0, TAU); ctx.fill();
    ring({ x: cx, y: cy }, planet, rgba(dark ? C.accent : C.line2, dark ? 0.35 : 1), 1);
    if (dark) { // the lit limb
      ctx.beginPath(); ctx.arc(cx, cy, planet, 195 * RAD, 285 * RAD);
      ctx.strokeStyle = rgba(C.accent, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (!dark) { ctx.setLineDash([2, 5]); ring({ x: cx, y: cy }, planet * 1.07, rgba(C.line2, 1), 1); ctx.setLineDash([]); }
  }
  function drawOrbits() {
    for (var i = 0; i < ORBITS.length; i++) {
      var o = ORBITS[i];
      if (small && i === 3) continue;
      ctx.beginPath();
      for (var j = 0; j <= 96; j++) { var p = proj(o.r * unit, j / 96 * TAU, o.roll); j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
      ctx.setLineDash(o.dash ? [2, 6] : []);
      ctx.strokeStyle = dark ? rgba(C.accent, 0.2) : rgba(C.line2, 1); ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!dark) { // the diagram's tick marks on the outer orbit
      ctx.fillStyle = rgba(C.muted, 0.5);
      for (var a = 0; a < 360; a += 15) { var q = proj(ORBITS[2].r * unit, a * RAD, ORBITS[2].roll); ctx.fillRect(q.x - 1, q.y - 1, 2, 2); }
    }
  }
  function drawSats(t, glow) {
    var list = [];
    for (var i = 0; i < SATS.length; i++) if (active(i)) list.push({ i: i, p: satAt(i, t) });
    list.sort(function (a, b) { return b.p.z - a.p.z; });
    var sz = small ? 10 : 13;
    list.forEach(function (it) {
      var s = SATS[it.i], p = it.p, far = (p.z > 0 ? 0.72 : 1) * (behindCopy(p) ? 0.3 : 1);
      ctx.globalAlpha = far;
      if (s.l) {
        var r = sz * p.k;
        if (glow[it.i]) ring(p, r + 3 + glow[it.i] * 9, rgba(C.accent, 0.9 * (1 - glow[it.i])), 1.5);
        ctx.fillStyle = C.panel; ctx.beginPath(); ctx.arc(p.x, p.y, r + 2, 0, TAU); ctx.fill();
        ctx.fillStyle = C["tint-" + s.tint]; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
        ctx.fillStyle = C.fg; ctx.font = "600 " + Math.round(r * 0.95) + "px 'Google Sans', system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(s.l, p.x, p.y + 0.5);
      } else {
        ctx.fillStyle = s.o === 3 ? rgba(C.muted, 0.8) : C.accent;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3 * p.k, 0, TAU); ctx.fill();
      }
    });
    ctx.globalAlpha = 1;
  }
  function drawCheck(t, ev, from) {
    var d = t - ev.t, arrive = 0.6, tick = 2.15, leave = 2.9, gone = 3.5;
    if (d < 0 || d > gone) return;
    if (d < arrive) { pulse(from, check, ease(d / arrive), 1); return; }
    var fade = 1 - clamp01((d - leave) / (gone - leave));
    strokeCurve(from, check, 0, 1, rgba(C.accent, 0.28 * fade), 1, [3, 4]);
    var ok = d >= tick, grow = clamp01((d - tick) / 0.25), col = ok ? C.ok : C.warn;
    if (!ok) { // breathing amber halo while it waits for you
      var b = 0.5 + 0.5 * Math.sin((d - arrive) * TAU / 1.6);
      var g = ctx.createRadialGradient(check.x, check.y, 6, check.x, check.y, 22 + b * 6);
      g.addColorStop(0, rgba(C.warn, 0.35)); g.addColorStop(1, rgba(C.warn, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(check.x, check.y, 28, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = fade;
    ctx.fillStyle = ok ? C.panel : C["warn-soft"]; ctx.beginPath(); ctx.arc(check.x, check.y, 10, 0, TAU); ctx.fill();
    ring(check, 10, col, 1.6);
    if (ok) {
      ctx.beginPath(); ctx.moveTo(check.x - 4, check.y + 0.5); ctx.lineTo(check.x - 1.2, check.y + 3.3);
      ctx.lineTo(check.x + 4.4, check.y - 3); ctx.strokeStyle = C.ok; ctx.lineWidth = 1.8; ctx.lineCap = "round";
      ctx.globalAlpha = fade * grow; ctx.stroke(); ctx.lineCap = "butt";
      if (d >= leave - 0.4) pulse(check, enter, ease(clamp01((d - leave + 0.4) / 0.5)), fade);
    } else {
      ctx.fillStyle = C.warn; ctx.beginPath(); ctx.arc(check.x, check.y, 2.6, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(backdrop, -12 - tiltX * 6, -12 - tiltY * 6, W + 24, H + 24);
    drawPlanet(); drawOrbits();
    var glow = {}, k0 = Math.max(0, Math.floor((t - 6) / 3.2) + 1), work = [];
    for (var k = Math.max(0, k0 - 2); k <= k0 + 3; k++) { var ev = eventAt(k); if (ev && ev.t <= t && t - ev.t < 3.6) work.push(ev); }
    work.forEach(function (ev) {
      var d = t - ev.t;
      if (ev.check) { if (d < 0.6) glow[ev.f] = 0; return; }
      if (d < 1.1) glow[ev.f] = 0; else if (d < 1.7) glow[ev.to] = (d - 1.1) / 0.6;
    });
    drawSats(t, glow);
    work.forEach(function (ev) {
      var from = satAt(ev.f, t), d = t - ev.t;
      if (ev.check) drawCheck(t, ev, from);
      else if (d < 1.1) pulse(from, satAt(ev.to, t), ease(d / 1.1), 1);
    });
  }

  function frame(now) {
    raf = 0;
    var dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now; clock += dt;
    var f = 1 - Math.exp(-dt / 0.35);
    tiltX += (aimX - tiltX) * f; tiltY += (aimY - tiltY) * f;
    draw(clock);
    schedule();
  }
  function schedule() {
    if (!raf && onScreen && !document.hidden && !reduce.matches) raf = requestAnimationFrame(frame);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
  function refresh() {
    if (!layout()) return;
    if (reduce.matches) { stop(); tiltX = tiltY = 0; draw(STILL); } else { draw(clock); schedule(); }
    canvas.classList.add("is-on");
  }
  function retheme() { readColors(); refresh(); }

  readColors();
  refresh();

  if (window.ResizeObserver) new ResizeObserver(function () { events = []; refresh(); }).observe(stage);
  else window.addEventListener("resize", refresh);
  if (window.IntersectionObserver) new IntersectionObserver(function (e) {
    onScreen = e[0].isIntersecting; if (onScreen) schedule(); else stop();
  }).observe(stage);
  document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else schedule(); });
  [reduce, mq("(prefers-color-scheme: dark)")].forEach(function (m) {
    if (m.addEventListener) m.addEventListener("change", retheme);
  });
  new MutationObserver(retheme).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (reduce.matches) refresh(); });
  window.addEventListener("pointermove", function (e) {
    if (!fine.matches) return;
    aimX = e.clientX / window.innerWidth * 2 - 1; aimY = e.clientY / window.innerHeight * 2 - 1;
  }, { passive: true });
})();
