const NORKART_API =
  "https://norkartrenovasjon.azurewebsites.net/proxyserver.ashx?server=" +
  "https://komteksky.norkart.no/MinRenovasjon.Api/api/";
// Public key embedded in the Min Renovasjon apps. Not an official API; may change without notice.
const NORKART_APP_KEY = "AE13DEEC-804F-4615-A74E-B4FAC11F0A30";
const USER_AGENT = "minrenovasjon-ical";
const CACHE_SECONDS = 6 * 60 * 60;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== "/feed") return text("Not found", 404);
    const p = url.searchParams;

    if (env.FEED_KEY && p.get("key") !== env.FEED_KEY) {
      return text("Forbidden", 403);
    }
    if (!p.get("address") || !p.get("municipality")) {
      return text("Usage: /feed?address=<street and number>&municipality=<name or number>", 400);
    }

    const cached = await caches.default.match(req);
    if (cached) return cached;

    try {
      const addr = await lookupAddress(p.get("address"), p.get("municipality"));
      const { fractions, schedule } = await fetchSchedule(addr);
      const resp = new Response(buildIcs(addr, fractions, schedule), {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        },
      });
      ctx.waitUntil(caches.default.put(req, resp.clone()));
      return resp;
    } catch (e) {
      console.error(e);
      return text(e.message || String(e), e.status || 502);
    }
  },
};

// --- Address lookup (Kartverket / Geonorge) ---------------------------------

async function lookupAddress(address, municipality) {
  const q = new URLSearchParams({ sok: address, treffPerSide: "1" });
  q.set(/^\d{4}$/.test(municipality) ? "kommunenummer" : "kommunenavn", municipality);

  const r = await fetch(`https://ws.geonorge.no/adresser/v1/sok?${q}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw httpError(`Address lookup failed: HTTP ${r.status}`, 502);
  const a = (await r.json()).adresser?.[0];
  if (!a) throw httpError(`No address found for "${address}" in ${municipality}`, 404);

  return {
    label: a.adressetekst,
    street: a.adressenavn,
    number: String(a.nummer),
    streetCode: String(a.adressekode),
    municipality: a.kommunenummer,
  };
}

// --- Collection schedule (Norkart Min Renovasjon) ---------------------------

async function norkart(path, municipality) {
  const r = await fetch(NORKART_API + path, {
    headers: { Kommunenr: municipality, RenovasjonAppKey: NORKART_APP_KEY, "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw httpError(`Min Renovasjon ${path.split("?")[0]}: HTTP ${r.status}`, 502);
  return r.json();
}

async function fetchSchedule(addr) {
  const qs = new URLSearchParams({ gatenavn: addr.street, husnr: addr.number, gatekode: addr.streetCode });
  const schedule = await norkart(`tommekalender?${qs}`, addr.municipality);
  if (!Array.isArray(schedule) || !schedule.length) {
    throw httpError(
      "No collection dates found. The municipality may not use Min Renovasjon, or the " +
        "collection agreement may be registered on another address (e.g. the housing cooperative's).",
      404,
    );
  }
  const fractions = Object.fromEntries((await norkart("fraksjoner", addr.municipality)).map((f) => [f.Id, f.Navn]));
  return { fractions, schedule };
}

// --- iCalendar output (RFC 5545) --------------------------------------------

function buildIcs(addr, fractions, schedule) {
  // One all-day event per collection day, listing every fraction collected that day.
  const byDay = new Map();
  for (const entry of schedule) {
    for (const d of entry.Tommedatoer ?? []) {
      const day = d.slice(0, 10).replaceAll("-", "");
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day).add(fractions[entry.FraksjonId] ?? `Fraksjon ${entry.FraksjonId}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//minrenovasjon-ical//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`Avfall – ${addr.label}`)}`,
    "X-WR-TIMEZONE:Europe/Oslo",
    "REFRESH-INTERVAL;VALUE=DURATION:P1D",
    "X-PUBLISHED-TTL:P1D",
  ];

  for (const day of [...byDay.keys()].sort()) {
    const types = [...byDay.get(day)].sort((a, b) => a.localeCompare(b, "nb")).join(", ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${day}-${addr.municipality}-${addr.streetCode}-${addr.number}@minrenovasjon-ical`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${addDays(day, 1)}`,
      `SUMMARY:${escapeText(`🗑️ ${types}`)}`,
      "TRANSP:TRANSPARENT",
      // All-day events start at local midnight, so this fires at 19:00 the evening before.
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(types)}`,
      "TRIGGER:-PT5H",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function addDays(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

// Fold lines longer than 75 octets without splitting multi-byte characters.
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    if (enc.encode(cur + ch).length > limit) {
      parts.push(cur);
      cur = "";
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
