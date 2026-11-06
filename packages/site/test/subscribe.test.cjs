// node --test: the newsletter function (api/subscribe.js). Fake project values only.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const handler = require("../api/subscribe.js");

const URL_ = "https://proj.supabase.co";
const KEY = "sb_publishable_x";

function req(method, body, contentType = "application/json") {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const r = Readable.from(raw ? [Buffer.from(raw)] : []);
  r.method = method;
  r.headers = contentType ? { "content-type": contentType } : {};
  return r;
}

function res() {
  const out = { statusCode: 0, headers: {}, body: "" };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (b) => { out.body = b || ""; };
  out.json = () => JSON.parse(out.body);
  return out;
}

function withEnv(url, key, fn) {
  return async () => {
    const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_PUBLISHABLE_KEY };
    const savedFetch = global.fetch;
    if (url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = url;
    if (key === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = key;
    try {
      await fn();
    } finally {
      global.fetch = savedFetch;
      if (saved.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.u;
      if (saved.k === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = saved.k;
    }
  };
}

function stubFetch(status) {
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); };
  return calls;
}

test("forwards a valid signup to Supabase with the env key and answers 200", withEnv(URL_ + "/", KEY, async () => {
  const calls = stubFetch(201);
  const r = res();
  await handler(req("POST", { email: " a@b.co ", source: "site" }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_ + "/rest/v1/newsletter_signups");
  assert.equal(calls[0].init.headers.apikey, KEY);
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: "a@b.co", source: "site" });
}));

test("a repeat signup (409 upstream) looks like a new one", withEnv(URL_, KEY, async () => {
  stubFetch(409);
  const r = res();
  await handler(req("POST", { email: "a@b.co" }), r);
  assert.equal(r.statusCode, 200);
}));

test("rejects bad input without calling Supabase", withEnv(URL_, KEY, async () => {
  const calls = stubFetch(201);
  const bad = [
    { email: "not-an-email" },
    { email: "a@b.co", source: "elsewhere" },
    { email: "a@b.co", extra: 1 },
    { email: "a@b.co", source: "site", id: 5 },
    { email: 42 },
    { email: "x".repeat(250) + "@b.co" },
    [{ email: "a@b.co" }],
    "{not json",
    null,
  ];
  for (const b of bad) {
    const r = res();
    await handler(req("POST", b === null ? "null" : b), r);
    assert.equal(r.statusCode, 400, JSON.stringify(b));
    assert.deepEqual(r.json(), { ok: false, error: "invalid_request" });
  }
  const big = res();
  await handler(req("POST", JSON.stringify({ email: "a@b.co", pad: "x".repeat(2000) })), big);
  assert.equal(big.statusCode, 400);
  const wrongType = res();
  await handler(req("POST", "email=a@b.co", "application/x-www-form-urlencoded"), wrongType);
  assert.equal(wrongType.statusCode, 415);
  const get = res();
  await handler(req("GET"), get);
  assert.equal(get.statusCode, 405);
  assert.equal(calls.length, 0);
}));

test("answers a generic 503 when the env is not set", withEnv(undefined, "", async () => {
  const calls = stubFetch(201);
  const r = res();
  await handler(req("POST", { email: "a@b.co" }), r);
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.json(), { ok: false, error: "unavailable" });
  assert.equal(calls.length, 0);
}));

test("hides upstream failures behind a generic 502", withEnv(URL_, KEY, async () => {
  global.fetch = async () => new Response(JSON.stringify({ message: "secret detail" }), { status: 401 });
  const r = res();
  await handler(req("POST", { email: "a@b.co" }), r);
  assert.equal(r.statusCode, 502);
  assert.ok(!r.body.includes("secret detail"));
  global.fetch = async () => { throw new TypeError("fetch failed"); };
  const r2 = res();
  await handler(req("POST", { email: "a@b.co" }), r2);
  assert.equal(r2.statusCode, 502);
  assert.deepEqual(r2.json(), { ok: false, error: "unavailable" });
}));

test("uses a body Vercel already parsed", withEnv(URL_, KEY, async () => {
  stubFetch(201);
  const r = res();
  const pre = req("POST");
  pre.body = { email: "a@b.co", source: "site" };
  await handler(pre, r);
  assert.equal(r.statusCode, 200);
}));
