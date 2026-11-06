// node --test: the Content-Security-Policy in vercel.json still matches the pages.
// The CSP allows the one inline theme script by its sha256, so editing that script without updating
// vercel.json would silently break the theme on the live site. This catches it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const PAGES = ["index.html", "404.html"];

function csp() {
  const config = JSON.parse(read("vercel.json"));
  for (const rule of config.headers) {
    for (const h of rule.headers) if (h.key === "Content-Security-Policy") return h.value;
  }
  throw new Error("no Content-Security-Policy in vercel.json");
}

function directive(policy, name) {
  const part = policy.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));
  return part ? part.split(/\s+/).slice(1) : [];
}

test("every inline script is allowed by its sha256", () => {
  const allowed = directive(csp(), "script-src");
  for (const page of PAGES) {
    const scripts = [...read(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const body of scripts) {
      const hash = "'sha256-" + crypto.createHash("sha256").update(body, "utf8").digest("base64") + "'";
      assert.ok(allowed.includes(hash), page + ": inline script not in script-src; expected " + hash);
    }
  }
});

test("pages use no inline styles or inline event handlers (the CSP blocks both)", () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /\sstyle\s*=/i, page + " has a style attribute");
    assert.doesNotMatch(html, /<style[\s>]/i, page + " has a <style> element");
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, page + " has an inline event handler");
  }
});

test("the newsletter can still reach its function and the release lookup can reach GitHub", () => {
  const connect = directive(csp(), "connect-src");
  assert.ok(connect.includes("'self'"), "connect-src must allow 'self' for /api/subscribe");
  assert.ok(connect.includes("https://api.github.com"), "connect-src must allow the GitHub releases API");
  assert.match(read("main.js"), /var ENDPOINT = "\/api\/subscribe";/);
});

test("every local asset the pages reference exists", () => {
  for (const page of [...PAGES, "styles.css"]) {
    const refs = [...read(page).matchAll(/(?:href|src)="(\/[^"#?]*)"|url\("(\/[^"]+)"\)/g)]
      .map((m) => m[1] || m[2])
      .filter((p) => p !== "/" && !p.startsWith("/api/"));
    for (const ref of refs) {
      assert.ok(fs.existsSync(path.join(root, ref)), page + " references missing " + ref);
    }
  }
});
