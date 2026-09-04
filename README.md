# ufound-slots

Availability calculator for the ufound Mechanical inbound booking agent.
Pure arithmetic — no database, no state, no network in the normal path.

Called by the Make.com scenario as module 7, between the Distance Matrix lookup and the
webhook response.

## Why this is a separate function

Make's array functions have no `reduce` — the set is `add`, `distinct`, `flatten`, `join`,
`map`, `merge`, `slice`, `sort` and a few more, with no fold of any kind. `map` exists and the
scenario uses it, but Make's `map` projects one key out of an array of objects into a flat list;
it cannot construct an object and it cannot accumulate.

The rules need an accumulation: for each two-hour slot, total the busy minutes across a variable
number of calendar events. Natively that means an Iterator inside a Repeater — roughly 500
operations per call instead of the 8 the scenario uses today.

Make's **Custom Functions** would be the obvious alternative, and they are real JavaScript. They
are [enterprise-only](https://help.make.com/custom-functions), capped at 5,000 characters with a
300 ms ceiling, synchronous, and cannot make HTTP calls. `worker.js` is ~16,000 characters, so it
would not fit regardless of plan.

Correct slots carry the largest weight in this exercise, so that piece is isolated where it can be
unit-tested rather than assumed. **Everything that touches an API stays in Make** — webhook, trade
routing, geocoding, Google Calendar, Distance Matrix, response shaping, error branches — where it
is visible in the blueprint.

## Timezone

Inputs and outputs are naive **Eastern** wall-clock strings, `YYYY-MM-DDTHH:mm:ss`. Anything
arriving with a zone (`...Z` or `...-04:00`) is converted to Eastern once, at the edge. After that
the code never converts, so DST transitions and offset arithmetic cannot introduce a bug.

The brief specifies `America/Chicago`; Eyal confirmed **Eastern** by email on 2026-09-03, and the
shared calendar's own timezone is `America/Toronto`, which agrees.

## Rules implemented

1. 14 calendar days from today, inclusive
2. Monday–Friday only
3. Slots 08–10, 10–12, 12–14, 14–16
4. Today only: drop any slot starting less than 2 hours from now
5. A slot survives if at least 60 of its 120 minutes are free
6. A technician with a job more than 15 minutes' drive from the caller loses that **whole day**

## Run

```bash
node test.js          # 59 assertions, no network required
npx wrangler deploy   # publish
```

Tests check both sides of every boundary — 59 free minutes fails and 60 passes; a 14-minute drive
does not block a day and one second over 15 does. A test in the middle of a range passes whether
the code says `>` or `>=`, so only the ones sitting on the line are informative.

## Request

Two accepted shapes for the events.

**From Make** — Make's formula language has no JSON serialiser, so it cannot send an array of
objects. It sends parallel pipe-delimited lists instead, which are zipped back up here:

```json
{
  "trade": "electrical",
  "technician": "tech2@ufound-ai.com",
  "caller_address": "1203 W 6th St, Austin, TX 78703, USA",
  "eventStarts":     "2026-09-07T08:00:00|2026-09-08T14:00:00",
  "eventEnds":       "2026-09-07T10:00:00|2026-09-08T16:00:00",
  "eventLocations":  "4600 E Riverside Dr|11000 Research Blvd",
  "matrixLocations": "4600 E Riverside Dr|11000 Research Blvd",
  "matrixDurations": "1180|840"
}
```

`matrixDurations` are seconds, matched to `matrixLocations` **by address string, not by index** —
Make sends `distinct()` locations to stay under Google's 25-destination cap, so any index-based
pairing would silently shift.

**Direct** — a plain array also works, which is how the tests and any `curl` call it:

```json
{
  "now": "2026-09-04T09:15:00",
  "blockedDates": ["2026-09-08"],
  "events": [
    { "start": "2026-09-04T08:30:00", "end": "2026-09-04T09:30:00", "location": "..." }
  ]
}
```

`now` is optional; the Worker uses its own clock when Make omits it. Events arrive already filtered
to one technician by the Make scenario — attendee email is the only ownership signal in the data.

## Response

```json
{
  "ok": true,
  "timezone": "America/New_York",
  "trade": "electrical",
  "technician": "tech2@ufound-ai.com",
  "blocked_dates": ["2026-09-07", "2026-09-09"],
  "slot_count": 29,
  "slots": [
    { "date": "2026-09-04", "day": "Friday", "start": "12:00", "end": "14:00",
      "free_minutes": 120, "spoken": "Friday the 4th, 12 to 2 in the afternoon" }
  ],
  "spoken_summary": "The earliest I have is ...",
  "instruction": "Read spoken_summary. Never state a time not in slots."
}
```

`spoken_summary` is composed here rather than by the agent, because anything the model composes it
can also invent. Pre-writing the sentence removes one opportunity to hallucinate a time.

## Failure responses

Each returns `ok: false` with a ready-made `spoken` line for the agent to read verbatim. **None of
them ever returns a time.**

| `error` | When |
|---|---|
| `bad_address` | The geocode came back empty **or too imprecise to dispatch to**. Google fails in two ways here, and neither raises an error Make can catch: it returns `ZERO_RESULTS` as a *successful* empty response, or it fuzzy-matches down to something useless — a real call gave `"Texas, USA"` for *"999999 Boulevard, Novosville"*. A dispatchable address needs a street number and at least three components. |
| `unknown_trade` | Technician is empty, meaning the trade matched none of the three. An empty technician would otherwise look like a technician with nothing booked. |
| `maps_unavailable` | Job locations were sent but no drive times came back, so rule 6 cannot be applied. Distinct from *no locations at all*, which legitimately means a technician with a free fortnight. |
| `no_availability` | The rules genuinely leave nothing in the window. |

## Files

| | |
|---|---|
| `worker.js` | The function. Exports `computeSlots`, `spokenSummary`, `toMin`, `drivingBlockedDates`, `toEasternWallClock` for testing. |
| `test.js` | 59 assertions. No mocks — the function is pure. |
| `test-agent.js` | Scripted conversations against the live Retell agent, with an independent slot validator and a hallucination check. |
