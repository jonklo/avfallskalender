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

const DAY_MS = 24 * 60 * 60 * 1000;
const today = Math.floor(Date.now() / DAY_MS);
const dmy = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10).split("-").reverse().join(".");
const ymd = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");

const calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, headers: init.headers });
  const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://ws.geonorge.no/")) {
    if (new URL(url).searchParams.get("sok") === "Nowhere 1") return json({ adresser: [] });
    const kommunenummer = new URL(url).searchParams.get("kommunenummer") ?? "3201";
    return json({ adresser: [{ adressetekst: "Storgata 1A", adressenavn: "Storgata", nummer: 1, bokstav: "A", adressekode: 222, kommunenummer }] });
  }
  if (url.startsWith("https://www.oslo.kommune.no/")) {
    return json({
      result: [{
        HentePunkts: [{
          Id: 1,
          Tjenester: [
            // Past date: projected forward every other week.
            { Fraksjon: { Tekst: "Restavfall" }, TommeDato: "05.01.2026", Hyppighet: { Faktor: 40000 } },
            // Future date: used as is, then weekly.
            { Fraksjon: { Tekst: "Papir" }, TommeDato: dmy(today + 2), Hyppighet: { Faktor: 10000 } },
          ],
        }],
      }],
    });
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

test("Oslo projects dates from the last known collection", async () => {
  const r = await get("address=Storgata%201A&municipality=0301");
  const ics = await r.text();
  assert.equal(r.status, 200, ics);
  const call = calls.find((c) => c.url.startsWith("https://www.oslo.kommune.no/"));
  assert.equal(new URL(call.url).searchParams.get("letter"), "A");
  assert.ok(!calls.some((c) => c.url.includes("norkart") && c.headers.Kommunenr === "0301"));

  const days = [...ics.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1]);
  assert.ok(days.includes("20260105"));
  // Every Restavfall day is a whole number of fortnights after the known one.
  const rest = [...ics.matchAll(/DTSTART;VALUE=DATE:(\d{8})[^]*?SUMMARY:🗑️ ([^\r]*)/g)]
    .filter((m) => m[2].includes("Restavfall"))
    .map((m) => Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8)) / DAY_MS);
  assert.ok(rest.length > 6);
  assert.ok(rest.every((d) => (d - Date.UTC(2026, 0, 5) / DAY_MS) % 14 === 0));
  assert.ok(rest.some((d) => d >= today && d < today + 15));
  assert.ok(days.includes(ymd(today + 2)) && days.includes(ymd(today + 9)));
  assert.match(ics, /UID:\d{8}-0301-222-1A@/);
});

test("errors follow Accept-Language", async () => {
  const req = (lang) =>
    worker.fetch(new Request("https://x.workers.dev/feed?address=Nowhere%201&municipality=3201", { headers: { "Accept-Language": lang } }), {}, ctx);
  const nb = await req("nb-NO,nb;q=0.9,en;q=0.8");
  assert.equal(nb.status, 404);
  assert.match(await nb.text(), /^Fant ingen adresse «Nowhere 1»/);
  assert.match(await (await req("en-GB,en;q=0.9,nb;q=0.8")).text(), /^No address found/);
});

test("FEED_KEY is enforced", async () => {
  assert.equal((await get("address=x&municipality=y", { FEED_KEY: "s" })).status, 403);
});
