const NORKART_API =
  "https://norkartrenovasjon.azurewebsites.net/proxyserver.ashx?server=" +
  "https://komteksky.norkart.no/MinRenovasjon.Api/api/";
// Public key embedded in the Min Renovasjon apps. Not an official API; may change without notice.
const NORKART_APP_KEY = "AE13DEEC-804F-4615-A74E-B4FAC11F0A30";
const USER_AGENT = "avfallskalender";
const CACHE_SECONDS = 6 * 60 * 60;

// Oslo runs its own collection service instead of Min Renovasjon.
const OSLO = "0301";
const OSLO_API = "https://www.oslo.kommune.no/actions/snap-lib-waste-complaint/search-by-address";
// Hyppighet.Faktor to days between collections. Only one day is known, so several times a week projects weekly.
const OSLO_INTERVAL_DAYS = { 10000: 7, 20000: 7, 30000: 7, 40000: 14, 50000: 28 };
const OSLO_HORIZON_DAYS = 90;
const ESTIMATE_NOTE = "Beregnet ut fra hvor ofte avfallet hentes. Kan avvike, for eksempel rundt helligdager.";
const DAY_MS = 24 * 60 * 60 * 1000;

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
      const collections = addr.municipality === OSLO ? await fetchOslo(addr) : await fetchMinRenovasjon(addr);
      const resp = new Response(buildIcs(addr, collections), {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        },
      });
      ctx.waitUntil(caches.default.put(req, resp.clone()));
      return resp;
    } catch (e) {
      console.error(e);
      const nb = /^(nb|nn|no)\b/i.test(req.headers.get("Accept-Language") ?? "");
      return text((nb && e.nb) || e.message || String(e), e.status || 502);
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
  if (!r.ok) throw httpError(`Address lookup failed: HTTP ${r.status}`, 502, `Adressesøket feilet: HTTP ${r.status}`);
  const a = (await r.json()).adresser?.[0];
  if (!a) {
    throw httpError(`No address found for "${address}" in ${municipality}`, 404, `Fant ingen adresse «${address}» i ${municipality}`);
  }

  return {
    label: a.adressetekst,
    street: a.adressenavn,
    number: String(a.nummer),
    letter: a.bokstav ?? "",
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

// Returns [{ date: "YYYYMMDD", name }], one entry per fraction and collection day.
async function fetchMinRenovasjon(addr) {
  const qs = new URLSearchParams({ gatenavn: addr.street, husnr: addr.number, gatekode: addr.streetCode });
  const schedule = await norkart(`tommekalender?${qs}`, addr.municipality);
  if (!Array.isArray(schedule) || !schedule.length) {
    throw httpError(
      "No collection dates found. The municipality may not use Min Renovasjon, or the " +
        "collection agreement may be registered on another address (e.g. the housing cooperative's).",
      404,
      "Fant ingen hentedager. Kommunen bruker kanskje ikke Min Renovasjon, eller avtalen kan " +
        "være registrert på en annen adresse (f.eks. borettslagets).",
    );
  }
  const fractions = Object.fromEntries((await norkart("fraksjoner", addr.municipality)).map((f) => [f.Id, f.Navn]));
  return schedule.flatMap((entry) =>
    (entry.Tommedatoer ?? []).map((d) => ({
      date: d.slice(0, 10).replaceAll("-", ""),
      name: fractions[entry.FraksjonId] ?? `Fraksjon ${entry.FraksjonId}`,
    })),
  );
}

// --- Collection schedule (Oslo kommune) -------------------------------------

async function fetchOslo(addr) {
  const qs = new URLSearchParams({ street: addr.street, number: addr.number, street_id: addr.streetCode });
  if (addr.letter) qs.set("letter", addr.letter);
  const r = await fetch(`${OSLO_API}?${qs}`, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!r.ok) throw httpError(`Oslo kommune: HTTP ${r.status}`, 502);
  const body = await r.json();
  const points = (body.result ?? body.data?.result)?.[0]?.HentePunkts ?? [];

  // The API only gives one date per fraction: the next collection, or the last one once it has passed.
  // Later dates are projected from the frequency and get corrected as the feed refreshes.
  const today = osloToday();
  const collections = [];
  for (const point of points) {
    for (const service of point.Tjenester ?? []) {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(service.TommeDato ?? "");
      if (!m) continue;
      const name = service.Fraksjon?.Tekst || "Avfall";
      const step = OSLO_INTERVAL_DAYS[service.Hyppighet?.Faktor] ?? 7;
      const known = Date.UTC(+m[3], +m[2] - 1, +m[1]) / DAY_MS;
      collections.push({ date: ymd(known), name });
      const next = known + Math.max(1, Math.ceil((today - known) / step)) * step;
      for (let day = next; day <= today + OSLO_HORIZON_DAYS; day += step) {
        collections.push({ date: ymd(day), name, estimated: true });
      }
    }
  }
  if (!collections.length) {
    throw httpError(
      "No collection dates found in Oslo kommune's lookup. The collection agreement may be " +
        "registered on another address (e.g. the housing cooperative's).",
      404,
      "Fant ingen hentedager i Oslo kommunes oppslag. Avtalen kan være registrert på en annen " +
        "adresse (f.eks. borettslagets).",
    );
  }
  return collections;
}

// Days since the Unix epoch for today's date in Norway.
function osloToday() {
  const [y, m, d] = new Date().toLocaleDateString("sv", { timeZone: "Europe/Oslo" }).split("-");
  return Date.UTC(+y, +m - 1, +d) / DAY_MS;
}

function ymd(epochDay) {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

// --- iCalendar output (RFC 5545) --------------------------------------------

function buildIcs(addr, collections) {
  // One all-day event per collection day, listing every fraction collected that day.
  const byDay = new Map();
  const estimated = new Set();
  for (const { date, name, estimated: guess } of collections) {
    if (!byDay.has(date)) byDay.set(date, new Set());
    byDay.get(date).add(name);
    if (guess) estimated.add(date);
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//avfallskalender//EN",
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
      `UID:${day}-${addr.municipality}-${addr.streetCode}-${addr.number}${addr.letter}@avfallskalender`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${addDays(day, 1)}`,
      `SUMMARY:${escapeText(`🗑️ ${types}`)}`,
      ...(estimated.has(day) ? [`DESCRIPTION:${escapeText(ESTIMATE_NOTE)}`] : []),
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

// nb is the Norwegian message, shown when the request prefers Norwegian.
function httpError(message, status, nb) {
  return Object.assign(new Error(message), { status, nb });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
