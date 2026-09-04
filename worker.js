/**
 * ufound Mechanical — availability slot calculator
 *
 * Pure arithmetic. No network, no clock, no timezone library.
 * Every timestamp in and out is a NAIVE Eastern wall-clock string
 * "YYYY-MM-DDTHH:mm:ss". We never convert to UTC, so DST and offset
 * bugs cannot happen — Make hands us Eastern, we do maths, we hand
 * Eastern back.
 *
 * Rules implemented (confirmed with Eyal 2026-09-03):
 *   1. 14 calendar days starting today, inclusive
 *   2. Monday–Friday only
 *   3. Slots 08–10, 10–12, 12–14, 14–16 Eastern
 *   4. Today only: drop any slot starting < 2h from now
 *   5. A slot survives if >= 60 of its 120 minutes are free
 *   6. Rule 3 (theirs): a blocked date removes the WHOLE day
 *
 * Blocked days can arrive two ways:
 *   a) `blockedDates: ["2026-09-08"]`               — caller already decided
 *   b) `locations: [...]` + `durations: [...]`      — parallel arrays straight
 *      out of one Google Distance Matrix call. We zip them by LOCATION STRING,
 *      not by index into events, so Make can send distinct() locations and
 *      stay under the 25-destination cap.
 */

const SLOT_HOURS = [8, 10, 12, 14];
const MAX_DRIVE_SECONDS = 15 * 60;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TZ = "America/New_York";

/**
 * Make hands us whatever Google Calendar gave it, and we do NOT control the
 * format: it may be naive ("2026-09-03T08:00:00"), UTC ("...T12:00:00Z"), or
 * offset-bearing ("...T08:00:00-04:00"). Anything carrying a zone is converted
 * to Eastern wall-clock here, once, at the edge. Everything downstream is then
 * naive Eastern and the arithmetic cannot drift.
 */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

const easternParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit"
});

function toEasternWallClock(s) {
  const str = String(s).trim();
  if (!HAS_ZONE.test(str)) return str;          // already naive Eastern
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;    // unparseable: leave it alone
  const p = Object.fromEntries(
    easternParts.formatToParts(d).filter((x) => x.type !== "literal")
                                 .map((x) => [x.type, x.value])
  );
  // Intl gives hour "24" for midnight in some runtimes; normalise it.
  const hh = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}`;
}

/** naive wall-clock string -> minutes since epoch (no timezone applied) */
function toMin(s) {
  const [d, t = "00:00:00"] = toEasternWallClock(s).split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  return Date.UTC(Y, M - 1, D, h, m) / 60000;
}

const dayKey = (s) => toEasternWallClock(s).split("T")[0];

/**
 * Make's aggregator names fields after the Google Calendar labels, and that
 * capitalisation has changed between app versions. Rather than depend on it,
 * accept any reasonable spelling and both the string and {dateTime}/{date}
 * shapes Google itself uses.
 */
const pick = (obj, ...names) => {
  for (const n of names) {
    const v = obj?.[n];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") return v.dateTime ?? v.date ?? "";
    return v;
  }
  return "";
};

const normalizeEvent = (e = {}) => ({
  start: pick(e, "start", "Start", "start_time", "startTime"),
  end: pick(e, "end", "End", "end_time", "endTime"),
  location: pick(e, "location", "Location")
});

/**
 * Make's formula language has no JSON serialiser (`toJSON` does not exist), so
 * the scenario cannot hand us an array of objects. What it CAN do is
 * `join(map(array; "field"); "|")`. So Make sends parallel pipe-delimited
 * lists and we zip them here. Pipes never appear in a street address, and
 * both ends of the contract are covered by tests.
 *
 * Plain arrays are still accepted, so the function is equally callable by
 * hand, by curl, or by anything that isn't Make.
 */
const asList = (v) =>
  Array.isArray(v)
    ? v
    : v === undefined || v === null || v === ""
      ? []
      : String(v).split("|");

function eventsFrom(body) {
  if (Array.isArray(body.events) && body.events.length) return body.events;

  const starts = asList(body.eventStarts);
  const ends = asList(body.eventEnds);
  const locs = asList(body.eventLocations);
  return starts.map((s, i) => ({
    start: String(s).trim(),
    end: String(ends[i] ?? "").trim(),
    location: String(locs[i] ?? "").trim()
  }));
}

const ordinal = (n) =>
  n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";

/** 8 -> "8", 12 -> "12", 14 -> "2" */
const hour12 = (h) => (h > 12 ? h - 12 : h);

const meridiem = (h) => (h < 12 ? "in the morning" : "in the afternoon");

/** a slot -> "Tuesday the 8th" */
const dayPhrase = (s) => {
  const dayNum = Number(s.date.slice(-2));
  return `${s.day} the ${dayNum}${ordinal(dayNum)}`;
};

/**
 * Zip one Distance Matrix response onto the events that caused it.
 * `locations[i]` corresponds to `durations[i]` (seconds). Any event whose
 * location drives longer than 15 minutes blocks its entire date.
 *
 * Matching is by trimmed, case-folded location string — the same key Make
 * used to build the distinct() list — so ordering bugs are impossible.
 */
function drivingBlockedDates(body = {}) {
  const events = eventsFrom(body);
  const locations = asList(body.locations ?? body.matrixLocations);
  const durations = asList(body.durations ?? body.matrixDurations);
  if (!locations.length) return [];
  const key = (s) => String(s || "").trim().toLowerCase();

  const secondsFor = new Map();
  locations.forEach((loc, i) => {
    const secs = Number(durations[i]);
    if (Number.isFinite(secs)) secondsFor.set(key(loc), secs);
  });

  const blocked = new Set();
  for (const raw of events) {
    const e = normalizeEvent(raw);
    if (!e.location) continue;              // no address -> blocks time, not the day
    const secs = secondsFor.get(key(e.location));
    if (secs === undefined) continue;       // unroutable -> don't block on a guess
    if (secs > MAX_DRIVE_SECONDS) blocked.add(dayKey(e.start));
  }
  return [...blocked];
}

/**
 * Google does not only fail with ZERO_RESULTS. Given something unparseable it
 * will often return a very LOW-PRECISION match instead and call it a success:
 * "999999 Boulevard, Novosville, 60000" comes back as "Texas, USA" — the
 * centroid of the state. That is non-empty, so an emptiness check passes it,
 * Distance Matrix then measures from the middle of Texas, and the caller is
 * offered a fortnight of appointments for a place that does not exist.
 *
 * A dispatchable service address needs a street number and at least three
 * components. "Texas, USA" has neither; "Austin, TX, USA" has no street number.
 */
function looksLikeStreetAddress(s) {
  const parts = String(s || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return false;   // "Texas, USA"
  return /\d/.test(parts[0]);           // first component must carry a street number
}

/** Eastern wall-clock for right now, from the Worker's own clock. */
const easternNow = () => toEasternWallClock(new Date().toISOString());

function computeSlots(body = {}) {
  const { blockedDates = [] } = body;
  // Callers may pass `now` (the tests do, so results are deterministic).
  // Make does not have to: getting the `now` variable into a Make formula is
  // fiddly, and the Worker has a perfectly good clock of its own.
  const now = body.now || easternNow();

  const events = eventsFrom(body).map(normalizeEvent).filter((e) => e.start && e.end);
  const nowMin = toMin(now);
  const blocked = new Set([...blockedDates, ...drivingBlockedDates(body)]);
  const [Y0, M0, D0] = dayKey(now).split("-").map(Number);
  const slots = [];

  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(Date.UTC(Y0, M0 - 1, D0 + offset));
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekends never available

    const date = d.toISOString().slice(0, 10);
    if (blocked.has(date)) continue; // their rule 3 — whole day gone

    const todays = events.filter((e) => dayKey(e.start) === date);

    for (const h of SLOT_HOURS) {
      const start = toMin(`${date}T${String(h).padStart(2, "0")}:00:00`);
      const end = start + 120;

      // today only: no slot starting less than 2 hours from now
      if (offset === 0 && start < nowMin + 120) continue;

      const busy = todays.reduce((sum, e) => {
        const es = toMin(e.start);
        const ee = toMin(e.end);
        return sum + Math.max(0, Math.min(end, ee) - Math.max(start, es));
      }, 0);

      if (120 - busy < 60) continue; // needs at least 1 of the 2 hours free

      const endH = h + 2;
      const dayNum = d.getUTCDate();
      slots.push({
        date,
        day: DAY_NAMES[dow],
        start: `${String(h).padStart(2, "0")}:00`,
        end: `${String(endH).padStart(2, "0")}:00`,
        free_minutes: 120 - busy,
        spoken: `${DAY_NAMES[dow]} the ${dayNum}${ordinal(dayNum)}, ` +
                `${hour12(h)} to ${hour12(endH)} ${meridiem(h)}`
      });
    }
  }
  return slots;
}

/**
 * Read three options aloud without sounding like a robot reading a table.
 *
 * The naive version repeats the date once per slot — "Tuesday the 8th, 8 to 10
 * in the morning, Tuesday the 8th, 12 to 2 in the afternoon, Tuesday the 8th,
 * 2 to 4 in the afternoon" — which is how a person would never say it, and on
 * a phone call the repetition is what makes an agent feel slow.
 *
 * So: say each day once, then its times. Drop "in the morning" / "in the
 * afternoon" when it hasn't changed since the previous time.
 *
 *   "Tuesday the 8th, 8 to 10 in the morning, 12 to 2 in the afternoon, or 2 to 4"
 */
function spokenSummary(slots) {
  if (slots.length === 0) return "";

  const days = [];
  for (const s of slots.slice(0, 3)) {
    const current = days[days.length - 1];
    if (current && current.date === s.date) current.slots.push(s);
    else days.push({ date: s.date, dayPhrase: dayPhrase(s), slots: [s] });
  }

  const spokenDays = days.map(({ dayPhrase: when, slots: daySlots }) => {
    let lastMeridiem = null;
    const times = daySlots.map((s) => {
      const h = Number(s.start.slice(0, 2));
      const phrase = `${hour12(h)} to ${hour12(h + 2)}`;
      const m = meridiem(h);
      if (m === lastMeridiem) return phrase;
      lastMeridiem = m;
      return `${phrase} ${m}`;
    });
    return `${when}, ${joinNaturally(times)}`;
  });

  return `The earliest I have is ${joinNaturally(spokenDays)}.`;
}

/** ["a","b","c"] -> "a, b, or c" */
function joinNaturally(items) {
  if (items.length <= 1) return items[0] ?? "";
  const rest = items.slice(0, -1);
  return `${rest.join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * One Distance Matrix call: caller address -> every distinct job address.
 *
 * This lives here rather than in Make because Make's "Get a Distance Matrix"
 * module wants an array of objects in `destinations`, and Make's formula
 * language cannot construct objects — only extract from them. Building that
 * array would mean an Iterator inside a Repeater and one API call per event.
 * One request, here, is cheaper and testable.
 *
 * Returns durations in seconds, positionally matched to `locations`.
 * Any failure returns [] so the caller degrades to "no day blocked" rather
 * than blocking everything.
 */
async function fetchDurations(origin, locations, key) {
  if (!key || !origin || !locations.length) return [];
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", origin);
  url.searchParams.set("destinations", locations.slice(0, 25).join("|"));
  url.searchParams.set("mode", "driving");
  url.searchParams.set("units", "imperial");
  url.searchParams.set("key", key);

  try {
    const res = await fetch(url, { cf: { cacheTtl: 300 } });
    if (!res.ok) return [];
    const data = await res.json();
    const elements = data?.rows?.[0]?.elements ?? [];
    return elements.map((e) =>
      e?.status === "OK" ? e?.duration?.value ?? null : null
    );
  } catch {
    return [];
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    }
    try {
      const body = await request.json();

      // Google's geocoder does not error on a nonsense address — it returns
      // ZERO_RESULTS, so Make hands us an empty formatted address and the flow
      // carries on happily offering times for a place nobody could find.
      // If the field was sent and came back blank, that IS the failure.
      const sentAddress = "caller_address" in body || "callerAddress" in body;
      const addressValue = String(body.caller_address ?? body.callerAddress ?? "").trim();
      if (sentAddress && (!addressValue || !looksLikeStreetAddress(addressValue))) {
        return Response.json({
          ok: false,
          error: "bad_address",
          spoken: "I couldn't find that address. Could you give me the street " +
                  "number and street name again?"
        });
      }

      // If Make sent a caller address but no drive times, look them up here.
      const callerAddress = String(body.callerAddress ?? body.caller_address ?? "").trim();
      if (callerAddress && !asList(body.matrixDurations ?? body.durations).length) {
        const key = (s) => String(s || "").trim().toLowerCase();
        const seen = new Set();
        const distinct = eventsFrom(body)
          .map((e) => normalizeEvent(e).location)
          .filter((l) => l && !seen.has(key(l)) && seen.add(key(l)));

        if (distinct.length) {
          body.matrixLocations = distinct;
          body.matrixDurations = await fetchDurations(
            callerAddress, distinct, env?.GOOGLE_MAPS_KEY
          );
        }
      }

      // An empty technician means the trade never matched one of the three.
      // Make's switch() returns "" for anything unexpected, the attendee filter
      // then matches nothing, and the caller would be told the technician is
      // free all fortnight. That is the most dangerous shape of wrong answer,
      // so refuse rather than answer.
      if ("technician" in body && !String(body.technician).trim()) {
        return Response.json({
          ok: false,
          error: "unknown_trade",
          spoken: "I want to make sure I send the right person out. " +
                  "Someone will call you back shortly to sort that out."
        });
      }

      // Rule 3 needs drive times. Two situations look identical from Make's
      // side — no durations came back — but they mean opposite things:
      //
      //   no job locations at all  -> this technician is free all fortnight,
      //                               nothing to measure, answer normally
      //   locations but no times   -> the distance lookup failed, so we cannot
      //                               apply rule 3 and must NOT answer, or we
      //                               would offer a day that should be blocked
      //
      // Silently returning slots in the second case is the dangerous one: it
      // looks like a perfect answer and is wrong.
      const haveLocations = asList(body.eventLocations)
        .some((s) => String(s).trim());
      const haveDurations = asList(body.matrixDurations ?? body.durations)
        .some((v) => v !== "" && v !== null && v !== undefined);

      if (haveLocations && !haveDurations) {
        return Response.json({
          ok: false,
          error: "maps_unavailable",
          spoken: "I'm having trouble working out travel times just now. " +
                  "Someone will call you back shortly to sort out a time."
        });
      }

      const slots = computeSlots(body);

      if (slots.length === 0) {
        return Response.json({
          ok: false,
          error: "no_availability",
          spoken: "I don't have any openings in the next two weeks for that. " +
                  "A team member will call you back to sort out a time."
        });
      }

      return Response.json({
        ok: true,
        timezone: "America/New_York",
        trade: body.trade ?? null,
        technician: body.technician ?? null,
        caller_address: body.caller_address ?? null,
        blocked_dates: drivingBlockedDates(body).concat(body.blockedDates ?? []),
        slot_count: slots.length,
        slots,
        spoken_summary: spokenSummary(slots),
        instruction:
          "Read spoken_summary to the caller. Offer at most three options. " +
          "If they ask about a different day, use the slots array. " +
          "Never state a date or time that is not in the slots array."
      });
    } catch (err) {
      return Response.json({ ok: false, error: "bad_request", detail: String(err) }, { status: 400 });
    }
  }
};

export { computeSlots, spokenSummary, toMin, drivingBlockedDates, toEasternWallClock,
         looksLikeStreetAddress };
