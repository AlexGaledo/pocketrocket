// PocketRocket site: no framework, no build step. Four jobs only:
// 1. fill in the download button with the latest Windows release
// 2. copy-to-clipboard for install command snippets
// 3. reveal sections as they scroll into view
// 4. the mobile nav toggle, and the hairline under the nav once the page scrolls

// Honoured in JS as well as CSS: with reduced motion we skip the observer entirely and just
// show everything, rather than running a 0.01ms transition on every element.
var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

(function latestRelease() {
  var btn = document.getElementById("download-btn");
  var versionEl = document.getElementById("download-version");
  if (!btn) return;

  fetch("https://api.github.com/repos/AlexGaledo/pocketrocket/releases/latest")
    .then(function (res) {
      if (!res.ok) throw new Error("no release yet");
      return res.json();
    })
    .then(function (release) {
      var asset = (release.assets || []).find(function (a) {
        return /\.exe$/i.test(a.name);
      });
      if (asset) {
        btn.href = asset.browser_download_url;
        if (versionEl) versionEl.textContent = release.tag_name || "";
      }
      // else: keep the fallback link to the Releases page already in the href
    })
    .catch(function () {
      // graceful fallback: button already points at the Releases page
    });
})();

(function copyButtons() {
  var buttons = document.querySelectorAll(".copy-btn[data-copy]");
  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        var original = btn.textContent;
        btn.classList.add("copied");
        btn.textContent = "Copied!";
        setTimeout(function () {
          btn.classList.remove("copied");
          btn.textContent = original;
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });
})();

(function scrollReveal() {
  // A group reveals its own children with a stagger; a plain [data-reveal] reveals itself.
  var groups = document.querySelectorAll("[data-reveal-group]");
  groups.forEach(function (group) {
    Array.prototype.forEach.call(group.children, function (child, i) {
      child.setAttribute("data-reveal", "");
      child.style.setProperty("--i", String(i));
    });
  });

  var targets = document.querySelectorAll("[data-reveal]");
  if (!targets.length) return;

  var show = function (el) { el.classList.add("is-in"); };

  // No observer support, or the visitor asked for less motion: show everything now.
  if (REDUCED || !("IntersectionObserver" in window)) {
    targets.forEach(show);
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        show(entry.target);
        io.unobserve(entry.target); // reveal once; re-animating on scroll-back is noise
      });
    },
    // Fire slightly before the element is fully on screen, so it is settled by the time it is read.
    { rootMargin: "0px 0px -12% 0px", threshold: 0.05 }
  );
  targets.forEach(function (el) { io.observe(el); });
})();

(function navBehaviour() {
  var nav = document.querySelector("header.site-nav");
  var toggle = document.querySelector(".nav-toggle");
  var links = document.getElementById("nav-links");
  if (!nav) return;

  // Hairline under the bar, only once there is content behind it.
  var onScroll = function () {
    nav.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if (!toggle || !links) return;

  var setOpen = function (open) {
    nav.classList.toggle("is-nav-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  toggle.addEventListener("click", function () {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });

  // Tapping a link, pressing Escape, or clicking away all close it.
  links.addEventListener("click", function (e) {
    if (e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener("click", function (e) {
    if (nav.contains(e.target)) return;
    setOpen(false);
  });
})();
