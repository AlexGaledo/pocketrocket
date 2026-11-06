// PocketRocket site: the launch layer. Decorative only; every element it touches is aria-hidden.
// 1. a canvas starfield in three parallax layers (scroll, and the pointer on mouse devices)
// 2. on load, a rocket lifts off from the flight path and draws a warm trail behind the headline,
//    then cuts its engine and the trail settles into a faint glow line
// 3. the flight path: that trail carried down the page as a scroll progress line with a node per section
// It runs only while the hero is on screen and the tab is visible. With reduced motion it paints the
// finished scene once and never moves it.
(function () {
  var sky = document.querySelector(".sky");
  var h1 = document.getElementById("hero-h");
  if (!sky || !h1 || !window.requestAnimationFrame) return;

  var canvas = sky.querySelector(".stars");
  var svg = sky.querySelector(".launch");
  var ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx || !svg) return;

  var glow = svg.querySelector(".trail-glow");
  var core = svg.querySelector(".trail-core");
  var grad = svg.querySelector("#trail-grad");
  var rocket = svg.querySelector(".rocket");
  var flame = svg.querySelector(".rocket-flame");
  var room = document.querySelector(".room");
  var fp = document.querySelector(".flightpath");
  var fpFill = fp && fp.querySelector(".fp-fill");
  var fpHead = fp && fp.querySelector(".fp-head");
  var fpNodes = fp ? [].slice.call(fp.querySelectorAll(".fp-node")) : [];

  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  var DELAY = 250, FLIGHT = 1700, SETTLE = 1100, TAIL = 280;

  var W = 0, H = 0, dpr = 1;
  var layers = [];
  var rgb = "255,255,255", starA = 1, starFade = 0;
  var len = 0, s0 = 0, P0 = [0, 0];
  var t0 = 0, done = false, settled = false;
  var onScreen = true, raf = 0, last = 0;
  var ptr = { tx: 0, ty: 0, x: 0, y: 0 };
  var fpTop = 0, fpH = 0, fpAbs = 0, nodeYs = [], fpShown = false;

  // ---- starfield ----
  // Per layer: density (px² per star), radius range, alpha range, scroll parallax, pointer parallax, twinkle.
  var SPEC = [
    { per: 9000, r: [0.45, 0.8], a: [0.25, 0.55], sc: 0.04, pp: 3, tw: 0 },
    { per: 24000, r: [0.8, 1.2], a: [0.45, 0.8], sc: 0.1, pp: 8, tw: 0.3 },
    { per: 80000, r: [1.25, 1.8], a: [0.7, 1], sc: 0.2, pp: 16, tw: 0.4 }
  ];
  var rand = function (a) { return a[0] + Math.random() * (a[1] - a[0]); };

  function makeStars() {
    // Phones get fewer stars on top of the smaller area.
    var k = finePointer ? 1 : 0.7;
    layers = SPEC.map(function (s) {
      var n = Math.round((W * H) / s.per * k), list = [];
      for (var i = 0; i < n; i++) {
        list.push({ x: Math.random() * W, y: Math.random() * H, r: rand(s.r), a: rand(s.a),
          w: 0.0006 + Math.random() * 0.0012, p: Math.random() * 6.3 });
      }
      return { s: s, stars: list };
    });
  }

  function readColors() {
    var cs = getComputedStyle(sky);
    rgb = (cs.getPropertyValue("--star").trim() || "255 255 255").split(/\s+/).join(",");
    starA = parseFloat(cs.getPropertyValue("--star-a")) || 1;
    starFade = parseFloat(cs.getPropertyValue("--star-fade")) || 0;
  }

  function drawStars(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgb(" + rgb + ")";
    var sy = reduce ? 0 : Math.min(window.scrollY || 0, H * 1.5);
    for (var l = 0; l < layers.length; l++) {
      var s = layers[l].s, list = layers[l].stars;
      var ox = ptr.x * s.pp, oy = ptr.y * s.pp - sy * s.sc;
      for (var i = 0; i < list.length; i++) {
        var st = list[i];
        var x = ((st.x + ox) % W + W) % W, y = ((st.y + oy) % H + H) % H;
        var f = y / H, a = st.a * starA * (1 - starFade * f * f);
        if (s.tw && !reduce) a *= 1 - s.tw * 0.5 * (1 + Math.sin(t * st.w + st.p));
        if (a < 0.02) continue;
        ctx.globalAlpha = a;
        if (st.r < 1.2) {
          ctx.fillRect(x - st.r, y - st.r, st.r * 2, st.r * 2);
        } else {
          ctx.beginPath(); ctx.arc(x, y, st.r, 0, 6.2832); ctx.fill();
          ctx.globalAlpha = a * 0.12;
          ctx.beginPath(); ctx.arc(x, y, st.r * 3.2, 0, 6.2832); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- geometry: the trail rises from the flight path (or the text's left edge), sweeps behind the
  // headline and parks the rocket just past its top-right corner ----
  function layout() {
    var sr = sky.getBoundingClientRect(), hr = h1.getBoundingClientRect();
    var w = Math.round(sr.width), h = Math.round(sr.height);
    fpShown = !!fp && getComputedStyle(fp).display !== "none";
    var fr = fpShown ? fp.getBoundingClientRect() : null;
    var heads = fpNodes.map(function (n) {
      var el = document.getElementById(n.getAttribute("data-for"));
      return el ? el.getBoundingClientRect() : null;
    });
    var safety = document.getElementById("safety");
    var safetyRect = safety && safety.getBoundingClientRect();
    var mainTop = fpShown ? fp.parentNode.getBoundingClientRect().top : 0;

    // writes from here on
    if (w !== W || h !== H) {
      W = w; H = h;
      dpr = Math.min(window.devicePixelRatio || 1, finePointer ? 2 : 1.5);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      makeStars();
    }

    var hx = hr.left - sr.left, hy = hr.top - sr.top, hw = hr.width, hh = hr.height;
    var padX = fr ? fr.left - sr.left + 4.5 : Math.max(5, hx - 10);
    // Wide screens: lift off from the flight path at the foot of the hero. Single column: from just under
    // the headline, so the trail never runs through the body copy.
    P0 = [padX, fr ? H : hy + hh + 28];
    var P3 = [Math.min(hx + hw + 34, W - 30), Math.max(hy - 2, 40)];
    // Climb straight up the gutter, then bank right behind the headline only.
    var L = [padX, Math.min(P0[1], hy + hh * 0.92)];
    var P1 = [padX, hy + hh * 0.42];
    var P2 = [hx + hw * 0.32, hy + hh * 0.5];
    var d = "M" + P0 + "L" + L + "C" + P1 + " " + P2 + " " + P3;
    glow.setAttribute("d", d); core.setAttribute("d", d);
    len = core.getTotalLength();
    // If the foot of the hero is below the fold, lift off from inside the viewport: the straight run
    // below that point is pre-drawn as the launch rail, so the lift-off itself is always seen.
    var fold = window.innerHeight - sr.top - 90;
    s0 = Math.max(0, Math.min(P0[1] - fold, P0[1] - L[1] - 40));
    glow.style.strokeDasharray = core.style.strokeDasharray = len + " " + (len + 10);

    if (fpShown) {
      fpTop = sr.bottom - mainTop;
      var end = safetyRect ? safetyRect.bottom - 120 - mainTop : fpTop + 2000;
      fpH = Math.max(0, end - fpTop);
      fp.style.top = fpTop + "px"; fp.style.height = fpH + "px";
      nodeYs = heads.map(function (r, i) {
        var y = r ? r.top + Math.min(r.height, 44) / 2 - mainTop - fpTop : 0;
        fpNodes[i].style.transform = "translateY(" + y + "px)";
        return y;
      });
    }
    sky.classList.add("is-ready");
  }

  // ---- the launch ----
  var ease = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var out = function (x) { return 1 - Math.pow(1 - x, 3); };

  function setTrail(p, tailLen) {
    var at = s0 + (len - s0) * p;
    var head = core.getPointAtLength(at);
    var behind = core.getPointAtLength(Math.max(0, at - 2));
    var tail = core.getPointAtLength(Math.max(0, tailLen));
    glow.style.strokeDashoffset = core.style.strokeDashoffset = len - at;
    grad.setAttribute("x1", tail.x); grad.setAttribute("y1", tail.y);
    grad.setAttribute("x2", head.x); grad.setAttribute("y2", head.y);
    var ang = at < 2 ? 0 : Math.atan2(head.y - behind.y, head.x - behind.x) * 57.2958 + 90;
    rocket.setAttribute("transform", "translate(" + head.x.toFixed(1) + " " + head.y.toFixed(1) + ") rotate(" + ang.toFixed(1) + ")");
    return at;
  }

  function setFlame(sx, sy) {
    flame.setAttribute("transform", "scale(" + sx.toFixed(2) + " " + sy.toFixed(2) + ")");
  }

  function finish() {
    setTrail(1, 0);
    setFlame(0, 0);
    sky.classList.add("is-settled");
    done = settled = true;
  }

  function updateLaunch(now) {
    var t = now - t0 - DELAY;
    if (t < 0) { setTrail(0, 0); setFlame(0.6, 0.5 + 0.1 * Math.sin(now * 0.05)); return; }
    var p = Math.min(1, t / FLIGHT);
    if (p < 1) {
      setTrail(ease(p), s0 + (len - s0) * ease(p) - TAIL);
      // Full burn on lift-off, a little flicker, easing back as it nears its orbit.
      var thrust = 0.75 + 0.35 * (1 - p) + 0.08 * Math.sin(now * 0.06);
      setFlame(1, thrust);
      return;
    }
    var q = Math.min(1, (t - FLIGHT) / SETTLE), e = out(q);
    // Engine cut and the tail of the gradient sweeps back to the pad, so the whole trail glows faintly.
    setTrail(1, (len - TAIL) * (1 - e));
    setFlame(Math.max(0, 1 - q * 3), Math.max(0, 1 - q * 3) * 0.8);
    if (!settled && q > 0.05) { settled = true; sky.classList.add("is-settled"); }
    if (q >= 1) finish();
  }

  // ---- flight path (scroll progress) ----
  function updatePath() {
    if (!fpShown || !fpH) return;
    // No layout reads here: the line's page offset is cached by relayout().
    var y = reduce ? fpH : Math.max(0, Math.min(fpH, (window.scrollY || 0) + window.innerHeight * 0.55 - fpAbs));
    fpFill.style.transform = "scaleY(" + (y / fpH).toFixed(4) + ")";
    fpHead.style.transform = "translateY(" + y.toFixed(1) + "px)";
    fpHead.style.opacity = y > 1 && y < fpH - 1 && !reduce ? "1" : "0";
    for (var i = 0; i < nodeYs.length; i++) fpNodes[i].classList.toggle("is-lit", y >= nodeYs[i] - 4);
  }

  // ---- loop ----
  function frame(now) {
    raf = 0;
    var dt = Math.min(64, now - (last || now)); last = now;
    if (!t0) t0 = now;
    var k = 1 - Math.exp(-dt / 220);
    ptr.x += (ptr.tx - ptr.x) * k; ptr.y += (ptr.ty - ptr.y) * k;
    drawStars(now);
    if (!done) updateLaunch(now);
    if (room && finePointer) room.style.translate = (ptr.x * -7).toFixed(2) + "px " + (ptr.y * -5).toFixed(2) + "px";
    schedule();
  }
  function schedule() {
    if (!raf && onScreen && !document.hidden && !reduce) raf = requestAnimationFrame(frame);
  }

  // Layout reads are batched into one rAF so resize and font swaps never thrash.
  var layoutQueued = false;
  function relayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(function () {
      layoutQueued = false;
      layout();
      fpAbs = fpTop + (fp ? fp.parentNode.getBoundingClientRect().top + (window.scrollY || 0) : 0);
      if (reduce || done) finish();
      if (reduce) drawStars(0);
      updatePath();
    });
  }

  readColors();
  relayout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(relayout);
    ro.observe(sky); ro.observe(document.body);
  } else {
    window.addEventListener("resize", relayout);
  }

  // Theme: the toggle sets data-theme; "system" follows the OS. Either way re-read the star colours.
  var onTheme = function () { readColors(); if (reduce || !onScreen) drawStars(0); };
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  var dark = matchMedia("(prefers-color-scheme: dark)");
  if (dark.addEventListener) dark.addEventListener("change", onTheme);

  if (reduce) return;

  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen) { last = 0; schedule(); }
    }).observe(sky);
  }
  document.addEventListener("visibilitychange", function () { last = 0; schedule(); });

  var scrollQueued = false;
  window.addEventListener("scroll", function () {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(function () { scrollQueued = false; updatePath(); });
  }, { passive: true });

  if (finePointer) {
    window.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse") return;
      ptr.tx = e.clientX / window.innerWidth * 2 - 1;
      ptr.ty = e.clientY / window.innerHeight * 2 - 1;
      schedule();
    }, { passive: true });
  }

  schedule();
})();
