// PocketRocket site: no framework, no build step. Shared by index.html and 404.html, so every section
// no-ops when its elements are missing. Jobs:
// 1. theme toggle (system / light / dark)
// 2. fill in the download button with the latest Windows release
// 3. copy-to-clipboard buttons on every code block
// 4. the mobile nav toggle
// 5. the nav hairline once the page has scrolled
// 6. newsletter signup (POST /api/subscribe)
// 7. print prep: open every FAQ answer
// The hero's chat illustration plays in pure CSS (styles.css, .room .b1 to .b5); nothing here drives it.

// One polite live region for short status messages (copy results), created up front so screen readers
// already track it when the first message lands.
var announce = (function () {
  var region = document.createElement("div");
  region.className = "sr-only";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.appendChild(region);
  return function (message) {
    // Clear first so the same message twice in a row is still read out.
    region.textContent = "";
    setTimeout(function () { region.textContent = message; }, 50);
  };
})();

// The theme the visitor picked: "system" unless the head script applied a saved light/dark choice.
function currentTheme() {
  var t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : "system";
}

(function themeToggle() {
  var root = document.documentElement;
  var btn = document.querySelector(".theme-toggle");
  var KEY = "pr-theme";
  var NEXT = { system: "light", light: "dark", dark: "system" };
  var NAME = { system: "System", light: "Light", dark: "Dark" };

  // The icon is pure CSS off data-theme; only the labels need JS.
  var apply = function (mode) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    if (btn) {
      btn.setAttribute("aria-label", "Theme: " + NAME[mode] + ". Switch to " + NAME[NEXT[mode]] + ".");
      btn.setAttribute("title", "Theme: " + NAME[mode]);
    }
  };

  apply(currentTheme());
  if (!btn) return;

  btn.addEventListener("click", function () {
    var mode = NEXT[currentTheme()];
    apply(mode);
    try {
      if (mode === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (e) {
      // storage blocked: the choice still holds for this page view
    }
  });

  // Another tab changed the theme: follow it. (System changes need nothing here: CSS media queries
  // already track them while the mode is "system".)
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    apply(e.newValue === "light" || e.newValue === "dark" ? e.newValue : "system");
  });
})();

(function latestRelease() {
  var btn = document.getElementById("download-btn");
  var versionEl = document.getElementById("download-version");
  if (!btn || !window.fetch) return;

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

(function codeCopy() {
  var blocks = document.querySelectorAll("pre > code");
  if (!blocks.length) return;

  var shortcut = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "Press ⌘C" : "Press Ctrl+C";
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

  var selectText = function (el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // Old or non-secure contexts: select the text and try execCommand. Returns whether it copied; on
  // failure the text stays selected so the visitor can copy it by hand.
  var legacyCopy = function (code) {
    selectText(code);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    if (ok) window.getSelection().removeAllRanges();
    return ok;
  };

  var copy = function (code) {
    var text = code.textContent.replace(/\n+$/, "");
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(code); }
      );
    }
    return Promise.resolve(legacyCopy(code));
  };

  blocks.forEach(function (code) {
    var pre = code.parentNode;
    var wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = ICON + '<span class="copy-label">Copy</span>';
    wrap.appendChild(btn);

    var label = btn.querySelector(".copy-label");
    var timer = null;
    var show = function (state, text, holdMs) {
      clearTimeout(timer);
      btn.classList.toggle("is-copied", state === "copied");
      btn.classList.toggle("is-failed", state === "failed");
      label.textContent = text;
      timer = setTimeout(function () {
        btn.classList.remove("is-copied", "is-failed");
        label.textContent = "Copy";
      }, holdMs);
    };

    btn.addEventListener("click", function () {
      copy(code).then(function (ok) {
        if (ok) {
          show("copied", "Copied", 1800);
          announce("Copied to clipboard");
        } else {
          show("failed", shortcut, 4000);
          announce("Couldn't copy automatically. The code is selected; " + shortcut.toLowerCase() + " to copy it.");
        }
      });
    });
  });
})();

(function navMenu() {
  var nav = document.querySelector("header.site-nav");
  var toggle = document.querySelector(".nav-toggle");
  var links = document.getElementById("nav-links");
  if (!nav || !toggle || !links) return;

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

(function navHairline() {
  var nav = document.querySelector("header.site-nav");
  if (!nav) return;

  // Scroll events can fire many times per frame; do the work at most once per frame.
  var queued = false;
  var update = function () {
    queued = false;
    // Hairline under the bar, only once there is content behind it.
    nav.classList.toggle("is-scrolled", (window.scrollY || window.pageYOffset || 0) > 8);
  };
  update();
  window.addEventListener("scroll", function () {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(update);
  }, { passive: true });
})();

(function newsletter() {
  var form = document.getElementById("newsletter-form");
  var success = document.getElementById("nl-success");
  var status = document.getElementById("nl-status");
  if (!form || !success || !status) return;

  var input = form.querySelector('input[name="email"]');
  var trap = form.querySelector('input[name="website"]');
  var btn = form.querySelector('button[type="submit"]');
  var label = btn && btn.querySelector(".nl-label");
  if (!input || !btn || !label) return;

  // Same-origin serverless function (api/subscribe.js) holds the Supabase settings; none of them ship in this page.
  var ENDPOINT = "/api/subscribe";
  // Same rule as the table's check constraint, so the server never rejects what the form accepted.
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var busy = false;

  var setStatus = function (message, invalid) {
    status.textContent = message;
    if (invalid) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  var setBusy = function (on) {
    busy = on;
    // aria-disabled instead of disabled: a disabled button drops keyboard focus mid-submit.
    btn.setAttribute("aria-busy", on ? "true" : "false");
    btn.setAttribute("aria-disabled", on ? "true" : "false");
    label.textContent = on ? "Subscribing…" : "Subscribe";
  };

  var succeed = function () {
    form.hidden = true;
    success.hidden = false;
    success.focus();
  };

  input.addEventListener("input", function () {
    if (status.textContent) setStatus("", false);
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (busy) return;

    var email = input.value.trim();
    if (!email) {
      setStatus("Enter your email address.", true);
      input.focus();
      return;
    }
    if (email.length > 254 || !EMAIL_RE.test(email) || !input.checkValidity()) {
      setStatus("That doesn't look like an email address. Check it and try again.", true);
      input.focus();
      return;
    }

    // Honeypot filled: almost certainly a bot. Look successful, send nothing.
    if (trap && trap.value) {
      succeed();
      return;
    }

    setStatus("", false);
    setBusy(true);

    var controller = window.AbortController ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, source: "site" }),
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        clearTimeout(timeout);
        setBusy(false);
        // The function answers a repeat signup like a new one, so the form never reveals who has signed up.
        if (res.ok) {
          succeed();
        } else {
          setStatus("Something went wrong on our side. Please try again in a moment.", false);
        }
      })
      .catch(function () {
        clearTimeout(timeout);
        setBusy(false);
        setStatus("Couldn't reach the server. Check your connection and try again.", false);
      });
  });
})();

(function printPrep() {
  // Not reset on beforeprint: if a second beforeprint arrives before afterprint, the first batch must
  // still be closed again afterwards.
  var opened = [];
  window.addEventListener("beforeprint", function () {
    document.querySelectorAll(".faq details").forEach(function (d) {
      if (!d.open) {
        d.open = true;
        opened.push(d);
      }
    });
  });
  window.addEventListener("afterprint", function () {
    opened.forEach(function (d) { d.open = false; });
    opened = [];
  });
})();
