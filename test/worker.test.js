// Runs the worker against mocked upstream APIs: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

const memCache = new Map();
globalThis.caches = {
  default: {
    match: async (req) => memCache.get(req.url)?.clone(),
    put: async (req, res) => void memCache.set(req.url, res),
  },
};

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, headers: init.headers });
  const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://ws.geonorge.no/")) {
    return json({ adresser: [{ adressetekst: "Storgata 1", adressenavn: "Storgata", nummer: 1, adressekode: 222, kommunenummer: "3201" }] });
  }
  if (url.includes("norkart")) {
    if (url.includes("fraksjoner")) return json([{ Id: 1, Navn: "Restavfall" }, { Id: 2, Navn: "Papir; papp" }, { Id: 3, Navn: "Matavfall" }]);
    return json([
      { FraksjonId: 1, Tommedatoer: ["2026-10-20T00:00:00", "2026-11-03T00:00:00"] },
      { FraksjonId: 2, Tommedatoer: ["2026-10-20T00:00:00"] },
      { FraksjonId: 3, Tommedatoer: ["2026-12-31T00:00:00"] },
    ]);
  }
  throw new Error("unexpected fetch " + url);
};

const worker = (await import("../src/index.js")).default;
const ctx = { waitUntil: () => {} };
const get = (qs, env = {}) => worker.fetch(new Request("https://x.workers.dev/feed?" + qs), env, ctx);

test("only /feed is handled", async () => {
  assert.equal((await worker.fetch(new Request("https://x.workers.dev/other"), {}, ctx)).status, 404);
});

test("municipality is required", async () => {
  assert.equal((await get("address=Storgata%201")).status, 400);
});

test("feed merges fractions per day", async () => {
  const r = await get("address=Storgata%201&municipality=3201");
  const ics = await r.text();
  assert.equal(r.status, 200, ics);
  assert.equal(r.headers.get("Content-Type"), "text/calendar; charset=utf-8");
  assert.ok(calls.some((c) => c.url.includes("tommekalender") && c.headers.Kommunenr === "3201"));
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.match(ics, /SUMMARY:🗑️ Papir\\; papp\\, Restavfall/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101/);
  assert.match(ics, /TRIGGER:-PT5H/);
  assert.ok(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));
});

test("FEED_KEY is enforced", async () => {
  assert.equal((await get("address=x&municipality=y", { FEED_KEY: "s" })).status, 403);
});
