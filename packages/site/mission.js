// Mission control: the hero's flight and the two scroll moments (countdown, pre-flight checklist).
// Decoration only. Everything it touches is aria-hidden or pseudo-content, and the HTML on its own is the
// finished state (rocket in orbit, approval at GO, every tick drawn), which is also what reduced motion,
// print and no-JS visitors get. The flight plays once; after it the only motion is the 1 Hz mission clock,
// and that stops while the hero is off-screen or the tab is hidden.
(function () {
  var launch = document.getElementById("launch");
  var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var NS = "http://www.w3.org/2000/svg";

  // ---- layout: fit the trajectory to where the words and the chat actually are ----
  var svg = launch && launch.querySelector(".flight");
  var flown = svg && svg.querySelector(".traj-flown");
  var ahead = svg && svg.querySelector(".traj-ahead");
  var hold = svg && svg.querySelector(".hold");
  var ship = svg && svg.querySelector(".ship");
  var limbs = svg ? svg.querySelectorAll(".limb, .limb-glow") : [];
  var mark = launch && launch.querySelector(".ruler-mark");
  var geo = null; // { total, holdAt } in px of path length
  var progress = 1; // 0..1 along the path; the markup's finished state is 1

  function r(n) { return Math.round(n * 10) / 10; }
  function P(x, y) { return r(x) + " " + r(y); }

  function layout() {
    if (!svg) return;
    var L = launch.getBoundingClientRect();
    var copy = launch.querySelector(".hero-copy").getBoundingClientRect();
    var card = launch.querySelector(".room").getBoundingClientRect();
    var hud = launch.querySelector(".hud").getBoundingClientRect();
    var W = L.width, H = L.height;
    var o = function (rc) {
      return { l: rc.left - L.left, r: rc.right - L.left, t: rc.top - L.top, b: rc.bottom - L.top, w: rc.width, h: rc.height };
    };
    copy = o(copy); card = o(card); hud = o(hud);
    svg.setAttribute("viewBox", "0 0 " + r(W) + " " + r(H));
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");

    // Earth's limb: a huge circle whose edge rises out of the telemetry strip at the bottom left.
    var R = Math.max(W, 900) * 1.4, cx = -0.1 * W, cy = hud.t - 120 + Math.sqrt(R * R - cx * cx);
    var limbY = function (x) { return cy - Math.sqrt(Math.max(0, R * R - (x - cx) * (x - cx))); };
    for (var i = 0; i < limbs.length; i++) {
      limbs[i].setAttribute("cx", r(cx)); limbs[i].setAttribute("cy", r(cy));
      limbs[i].setAttribute("r", r(R + (i ? 3 : 0)));
    }

    var S, Hd, d1, d2;
    if (card.l > copy.r) {
      // Side by side: a gravity turn. Lift off the limb under the copy, climb the gutter between the words
      // and the chat, hold above the chat for GO, then pitch over and burn along the top into orbit.
      var gx = (copy.r + card.l) / 2;
      var sx = Math.max(copy.l + 20, copy.r - 140);
      S = { x: sx, y: limbY(sx) - 3 };
      var M = { x: gx, y: card.t + card.h * 0.5 };
      Hd = { x: gx + 24, y: Math.max(40, card.t - 44) };
      var E = { x: Math.min(W - 36, card.r + (W - card.r) * 0.6), y: Math.max(24, Hd.y - 30) };
      d1 = "M" + P(S.x, S.y) + " C" + P(S.x + 30, S.y - (S.y - M.y) * 0.45) + " " + P(gx, M.y + (S.y - M.y) * 0.4) + " " + P(M.x, M.y) +
        " C" + P(gx, M.y - (M.y - Hd.y) * 0.5) + " " + P(Hd.x - 20, Hd.y + 44) + " " + P(Hd.x, Hd.y);
      d2 = " C" + P(Hd.x + 22, Hd.y - 48) + " " + P(E.x - (E.x - Hd.x) * 0.55, E.y - 2) + " " + P(E.x, E.y);
    } else {
      // Stacked: a short arc through the gap between the words and the chat, leaving off the right edge.
      var top = copy.b, bot = card.t, mid = (top + bot) / 2;
      S = { x: -12, y: bot - 8 };
      Hd = { x: W * 0.38, y: mid + (bot - top) * 0.12 };
      var E2 = { x: W - 22, y: top + 10 };
      d1 = "M" + P(S.x, S.y) + " C" + P(W * 0.12, S.y - 2) + " " + P(Hd.x - W * 0.12, Hd.y + 4) + " " + P(Hd.x, Hd.y);
      d2 = " C" + P(Hd.x + W * 0.14, Hd.y - 4) + " " + P(E2.x - W * 0.14, E2.y + 14) + " " + P(E2.x, E2.y);
    }
    flown.setAttribute("d", d1 + d2);
    ahead.setAttribute("d", d1 + d2);
    hold.setAttribute("transform", "translate(" + P(Hd.x, Hd.y) + ")");
    var label = hold.querySelectorAll("text");
    var flip = Hd.x > W * 0.6; // keep the label on-screen
    for (var k = 0; k < label.length; k++) {
      label[k].setAttribute("x", flip ? -16 : 16);
      label[k].setAttribute("text-anchor", flip ? "end" : "start");
    }

    var probe = document.createElementNS(NS, "path");
    probe.setAttribute("d", d1);
    probe.setAttribute("fill", "none");
    svg.appendChild(probe);
    var holdAt = probe.getTotalLength();
    svg.removeChild(probe);
    var total = flown.getTotalLength();
    geo = { total: total, holdAt: holdAt };
    flown.style.strokeDasharray = r(total + 2) + " " + r(total + 2);
    place(progress);
  }

  function place(p) {
    if (!geo) return;
    progress = p;
    var at = geo.total * p;
    flown.style.strokeDashoffset = r(geo.total + 2 - at);
    var a = flown.getPointAtLength(Math.max(0, at - 0.5));
    var b = flown.getPointAtLength(Math.min(geo.total, at + 0.5));
    var deg = Math.atan2(b.y - a.y, b.x - a.x) * 57.2958;
    ship.setAttribute("transform", "translate(" + P(b.x, b.y) + ") rotate(" + r(deg) + ")");
    if (mark) mark.style.transform = "translateY(" + r(Math.max(0, b.y - 24)) + "px)";
  }

  // ---- HUD text: types in, never announced (the whole strip is aria-hidden) ----
  var hudEls = {};
  if (launch) [].forEach.call(launch.querySelectorAll("[data-hud]"), function (el) { hudEls[el.getAttribute("data-hud")] = el; });
  var typing = {};
  function type(key, text, keep) {
    var el = hudEls[key];
    if (!el) return;
    clearTimeout(typing[key]);
    var base = keep ? el.textContent : "";
    var i = 0;
    var step = function () {
      el.textContent = base + text.slice(0, ++i);
      if (i < text.length) typing[key] = setTimeout(step, 24);
    };
    if (calm) el.textContent = base + text; else step();
  }

  // ---- mission clock ----
  var t0 = 0, clockTimer = 0, heroVisible = true;
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function tick() {
    clearTimeout(clockTimer);
    if (!t0 || calm || document.hidden || !heroVisible) return;
    var s = Math.floor((performance.now() - t0) / 1000);
    if (hudEls.clock) hudEls.clock.textContent = "T+" + pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60);
    clockTimer = setTimeout(tick, 1000 - ((performance.now() - t0) % 1000) + 8);
  }

  // ---- the flight ----
  // Steps: 1 you ask, 2 Lead hands off, 3 Coder works, 4 approval card, 5-7 the poll, press, 8 GO, 9 Writer.
  var STEPS = [[150, 1], [600, 2], [1000, 3], [1400, 4], [1800, 5], [2100, 6], [2400, 7], [2950, 8], [3500, 9]];
  var PRESS = 2750;
  var ASCENT = [150, 1450], ORBIT = [2950, 5400];
  var timers = [], raf = 0, flying = false;

  function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function cls(c, on) { launch.classList.toggle(c, on); }

  function frame(now) {
    var t = now - t0, p;
    var holdP = geo.holdAt / geo.total;
    if (t < ASCENT[0]) p = 0;
    else if (t < ASCENT[1]) p = holdP * ease((t - ASCENT[0]) / (ASCENT[1] - ASCENT[0]));
    else if (t < ORBIT[0]) p = holdP;
    else if (t < ORBIT[1]) p = holdP + (1 - holdP) * ease((t - ORBIT[0]) / (ORBIT[1] - ORBIT[0]));
    else p = 1;
    cls("is-burning", (t > ASCENT[0] && t < ASCENT[1] - 150) || (t > ORBIT[0] && t < ORBIT[1] - 300));
    place(p);
    if (t < ORBIT[1]) raf = requestAnimationFrame(frame);
    else { flying = false; cls("is-burning", false); }
  }

  function finish() {
    timers.forEach(clearTimeout); timers = [];
    cancelAnimationFrame(raf); flying = false;
    STEPS.forEach(function (s) { cls("st-" + s[1], true); });
    cls("st-press", false); cls("is-burning", false);
    place(1);
    if (hudEls.status) hudEls.status.textContent = "APPROVAL REQUIRED → GO";
    if (hudEls.crew) hudEls.crew.textContent = "3 ONLINE";
  }

  function fly() {
    t0 = performance.now();
    cls("mc-run", true);
    flying = true;
    place(0);
    if (hudEls.status) hudEls.status.textContent = "";
    if (hudEls.crew) hudEls.crew.textContent = "";
    hudEls.clock && (hudEls.clock.textContent = "T+00:00:00");
    var at = function (ms, fn) { timers.push(setTimeout(fn, ms)); };
    STEPS.forEach(function (s) { at(s[0], function () { cls("st-" + s[1], true); }); });
    at(200, function () { type("status", "STANDBY"); type("crew", "3 ONLINE"); });
    at(1400, function () { type("status", "APPROVAL REQUIRED"); });
    at(PRESS, function () { cls("st-press", true); });
    at(PRESS + 220, function () { cls("st-press", false); });
    at(2950, function () { type("status", " → GO", true); });
    raf = requestAnimationFrame(frame);
    tick();
  }

  if (launch && svg) {
    layout();
    var rs = 0;
    window.addEventListener("resize", function () {
      cancelAnimationFrame(rs);
      rs = requestAnimationFrame(layout);
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

    var inView = launch.getBoundingClientRect().top < innerHeight && launch.getBoundingClientRect().bottom > 0;
    if (!calm && inView && !document.hidden) fly();
    else launch.classList.add("mc-done");

    // A hidden tab would stall rAF mid-flight; land it instead.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && flying) finish();
      tick();
    });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) {
        heroVisible = es[0].isIntersecting;
        if (!heroVisible && flying) finish();
        tick();
      }).observe(launch);
    }
  }

  // ---- scroll moments: the countdown lights T-3, T-2, T-1, then T-0; the checklist ticks itself ----
  function sequence(list, items, gap, after) {
    if (calm || !("IntersectionObserver" in window) || !list) return;
    var box = list.getBoundingClientRect();
    if (box.top < innerHeight * 0.85) return; // already on screen: leave it finished, never rewind in view
    list.classList.add("is-armed");
    if (after) after.classList.add("is-armed");
    var io = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      [].forEach.call(items, function (li, i) {
        setTimeout(function () { li.classList.add("is-lit"); }, 120 + i * gap);
      });
      if (after) setTimeout(function () { after.classList.add("is-lit"); }, 120 + items.length * gap);
    }, { rootMargin: "0px 0px -20% 0px" });
    io.observe(list);
  }
  var cd = document.querySelector(".countdown");
  sequence(cd, cd ? cd.children : [], 420, document.querySelector(".liftoff"));
  var ck = document.querySelector(".checklist");
  sequence(ck, ck ? ck.children : [], 180, null);
})();
