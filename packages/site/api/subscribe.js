// Newsletter signup for the marketing site. Vercel serverless function (plain Node, no dependencies).
//
// The browser posts {email, source} here; this function forwards it to Supabase with a key that lives only in
// the Vercel project's environment, so no project URL or key is in the repo or in the shipped page.
//   SUPABASE_URL              https://<project>.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the project's publishable key (never a service-role / secret key)
// The table only allows INSERT of email + source = 'site' (supabase/migrations/20260915000000_newsletter_signups.sql).
//
// Every error the browser sees is generic: a repeat signup answers like a new one, so the form never reveals
// who is already on the list, and Supabase's own messages never reach the client.
"use strict";

// Same rule as the table's check constraint and the form in main.js.
var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
var MAX_BODY = 1024;
var UPSTREAM_TIMEOUT_MS = 8000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

// Vercel's Node helpers may already have parsed the body (req.body); fall back to reading the raw stream.
function readBody(req) {
  if (req.body !== undefined) {
    var b = req.body;
    if (Buffer.isBuffer(b)) b = b.toString("utf8");
    if (typeof b === "string") {
      if (b.length > MAX_BODY) return Promise.reject(new Error("too large"));
      return Promise.resolve(JSON.parse(b));
    }
    return Promise.resolve(b);
  }
  return new Promise(function (resolve, reject) {
    var size = 0;
    var chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** The signup to store, or null when the body is anything other than exactly {email, source?: "site"}. */
function parseSignup(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  var keys = Object.keys(body);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== "email" && keys[i] !== "source") return null;
  }
  if (typeof body.email !== "string") return null;
  var email = body.email.trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  if (body.source !== undefined && body.source !== "site") return null;
  return { email: email, source: "site" };
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "method_not_allowed" });
  }
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
    return send(res, 415, { ok: false, error: "invalid_request" });
  }

  var body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, 400, { ok: false, error: "invalid_request" });
  }
  var signup = parseSignup(body);
  if (!signup) return send(res, 400, { ok: false, error: "invalid_request" });

  var base = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  var key = String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  if (!base || !key) {
    console.error("[subscribe] SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
    return send(res, 503, { ok: false, error: "unavailable" });
  }

  try {
    var up = await fetch(base + "/rest/v1/newsletter_signups", {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(signup),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    // 409 = already on the list: answered like a new signup on purpose.
    if (up.status === 201 || up.status === 409) return send(res, 200, { ok: true });
    console.error("[subscribe] upstream answered " + up.status);
  } catch (e) {
    console.error("[subscribe] upstream unreachable: " + (e && e.name ? e.name : "error"));
  }
  return send(res, 502, { ok: false, error: "unavailable" });
}

module.exports = handler;
module.exports.parseSignup = parseSignup;
