/**
 * Live smoke test against the deployed Worker.
 *   node test-live.js
 *
 * test.js proves the logic. This proves the deployment — that the thing
 * Make will actually call behaves the same as the code on disk.
 */
const URL_ = process.env.WORKER_URL || "https://ufound-slots.muhammadhyaseenka.workers.dev/";

let pass = 0, fail = 0;

async function post(body) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        got : ${JSON.stringify(got)}`);
    console.log(`        want: ${JSON.stringify(want)}`);
  }
  ok ? pass++ : fail++;
}

const slotKeys = (j, date) =>
  j.slots.filter((s) => s.date === date).map((s) => s.start);

(async () => {
  console.log(`\nTesting ${URL_}\n`);

  console.log("Deployment");
  const t0 = Date.now();
  const base = await post({ now: "2026-09-04T09:00:00" });
  console.log(`  round trip: ${Date.now() - t0}ms`);
  check("responds 200", base.status, 200);
  check("ok flag set", base.json.ok, true);
  check("reports Eastern", base.json.timezone, "America/New_York");

  console.log("\nRule 4 — today's 2-hour cutoff");
  check(
    "at 09:00 Friday, today offers only 12-2 and 2-4",
    slotKeys(base.json, "2026-09-04"),
    ["12:00", "14:00"]
  );

  console.log("\nRule 2 — weekends");
  check(
    "Saturday 09-05 absent",
    base.json.slots.some((s) => s.date === "2026-09-05"),
    false
  );
  check(
    "Sunday 09-06 absent",
    base.json.slots.some((s) => s.date === "2026-09-06"),
    false
  );

  console.log("\nRule 5 — at least 1 of 2 hours free");
  const short = await post({
    now: "2026-09-04T06:00:00",
    events: [{ start: "2026-09-04T08:30:00", end: "2026-09-04T09:00:00" }]
  });
  check("30-min job keeps 08-10", slotKeys(short.json, "2026-09-04").includes("08:00"), true);

  const long = await post({
    now: "2026-09-04T06:00:00",
    events: [{ start: "2026-09-04T08:00:00", end: "2026-09-04T09:30:00" }]
  });
  check("90-min job kills 08-10", slotKeys(long.json, "2026-09-04").includes("08:00"), false);

  const straddle = await post({
    now: "2026-09-04T06:00:00",
    events: [{ start: "2026-09-04T09:00:00", end: "2026-09-04T11:00:00" }]
  });
  check(
    "2-hour job straddling two slots leaves both on exactly 60",
    straddle.json.slots.filter((s) => s.date === "2026-09-04")
      .map((s) => `${s.start}:${s.free_minutes}`),
    ["08:00:60", "10:00:60", "12:00:120", "14:00:120"]
  );

  console.log("\nRule 6 — blocked day");
  const blocked = await post({
    now: "2026-09-04T06:00:00",
    blockedDates: ["2026-09-08"]
  });
  check("blocked date gone entirely", slotKeys(blocked.json, "2026-09-08").length, 0);
  check("neighbouring day untouched", slotKeys(blocked.json, "2026-09-09").length, 4);

  console.log("\nError handling");
  const none = await post({
    now: "2026-09-04T06:00:00",
    blockedDates: ["2026-09-04","2026-09-07","2026-09-08","2026-09-09","2026-09-10",
                   "2026-09-11","2026-09-14","2026-09-15","2026-09-16","2026-09-17"]
  });
  check("no availability returns ok:false", none.json.ok, false);
  check("with a speakable line", typeof none.json.spoken === "string" && none.json.spoken.length > 0, true);

  const bad = await fetch(URL_, { method: "GET" });
  check("GET is rejected", bad.status, 405);

  const junk = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not json"
  });
  check("malformed body returns 400, not a crash", junk.status, 400);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
