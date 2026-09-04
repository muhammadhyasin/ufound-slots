/**
 * End-to-end conversation tests for the Ufound Mechanical voice agent.
 *
 *   export RETELL_API_KEY=your_key_here
 *   node test-agent.js
 *   node test-agent.js --only=ambiguous     # run a subset
 *   node test-agent.js --verbose            # print every turn
 *
 * This drives real conversations through Retell's playground endpoint, which
 * runs the actual conversation flow and calls the real Make webhook. Nothing
 * is mocked, so a green run means the whole chain works:
 *
 *   Retell flow -> check_availability -> Make -> Google Calendar
 *                -> attendee filter -> Distance Matrix -> Worker -> slots
 *
 * What it checks, mapped to the scoring in the brief:
 *
 *   45%  Availability output   every returned slot obeys the six rules, and
 *                              nothing invalid is ever offered
 *   30%  Job type              correct trade, and a follow-up question asked
 *                              ONLY when the caller left it genuinely open
 *   10%  Conversation quality  no trade list read out, no forbidden questions,
 *                              address confirmed back
 *   10%  Error handling        bad address and no-availability stay on the rails
 *    5%  Build quality         this file
 *
 * The check that matters most is HALLUCINATION: every date and time the agent
 * says out loud must appear in the slots array the function returned. That is
 * the failure the brief calls out, and it is invisible to a human listener
 * because a made-up appointment sounds exactly like a real one.
 */

const API = "https://api.retellai.com";
const AGENT_ID = process.env.AGENT_ID || "agent_c84e04978c8e88fede9cd9f85f";
const KEY = process.env.RETELL_API_KEY;

const VERBOSE = process.argv.includes("--verbose");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];

if (!KEY) {
  console.error("Set RETELL_API_KEY first:  export RETELL_API_KEY=...");
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * The rules, restated here on purpose.
 *
 * These are deliberately NOT imported from worker.js. If both the code
 * under test and the test read the same constant, a wrong constant passes.
 * ------------------------------------------------------------------ */
const LEGAL_START_HOURS = [8, 10, 12, 14];
const SLOT_MINUTES = 120;
const WINDOW_DAYS = 14;
const TODAY_CUTOFF_MINUTES = 120;
const TZ = "America/New_York"; // change with the Worker if Eyal says Central

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */
const ADDRESS_TURNS = [
  "It's 1203 West 6th Street, Austin, Texas, 7 8 7 0 3.",
  "Yes, that's right."
];

const SCENARIOS = [
  // ---- The six worked examples from the brief. None should need a question.
  {
    id: "pdf-1-water-on-floor",
    tags: ["classification", "pdf"],
    say: ["There's water all over my kitchen floor and I don't know where it's coming from.", ...ADDRESS_TURNS],
    expect: { trade: "plumbing", clarifyingQuestion: false }
  },
  {
    id: "pdf-2-half-house-no-power",
    tags: ["classification", "pdf"],
    say: ["Half my house has no power but the other half is fine.", ...ADDRESS_TURNS],
    expect: { trade: "electrical", clarifyingQuestion: false }
  },
  {
    id: "pdf-3-vents-warm",
    tags: ["classification", "pdf"],
    say: ["The air coming out of the vents is warm even though it's set to cold.", ...ADDRESS_TURNS],
    expect: { trade: "hvac", clarifyingQuestion: false }
  },
  {
    id: "pdf-4-toilet-running",
    tags: ["classification", "pdf"],
    say: ["My upstairs toilet keeps running and won't stop.", ...ADDRESS_TURNS],
    expect: { trade: "plumbing", clarifyingQuestion: false }
  },
  {
    id: "pdf-5-burning-smell-breaker",
    tags: ["classification", "pdf"],
    say: ["There's a burning smell near my breaker box.", ...ADDRESS_TURNS],
    expect: { trade: "electrical", clarifyingQuestion: false }
  },
  {
    id: "pdf-6-furnace-banging",
    tags: ["classification", "pdf"],
    say: ["My furnace is making a loud banging noise when it starts.", ...ADDRESS_TURNS],
    expect: { trade: "hvac", clarifyingQuestion: false }
  },

  // ---- Genuinely ambiguous. A question is REQUIRED; guessing is the failure.
  {
    id: "ambiguous-water-heater-gas",
    tags: ["classification", "ambiguous"],
    say: ["My water heater isn't working.", "It's a gas one.", ...ADDRESS_TURNS],
    expect: { trade: "plumbing", clarifyingQuestion: true }
  },
  {
    id: "ambiguous-water-heater-electric",
    tags: ["classification", "ambiguous"],
    say: ["I've got no hot water at all.", "It's electric.", ...ADDRESS_TURNS],
    expect: { trade: "electrical", clarifyingQuestion: true }
  },
  {
    id: "ambiguous-ac-dead-breaker",
    tags: ["classification", "ambiguous"],
    say: ["My AC isn't working.", "It won't turn on at all, and the breaker tripped.", ...ADDRESS_TURNS],
    expect: { trade: "electrical", clarifyingQuestion: true }
  },
  {
    id: "ambiguous-ac-running-warm",
    tags: ["classification", "ambiguous"],
    say: ["The air conditioner isn't working right.", "It runs, it just blows warm air.", ...ADDRESS_TURNS],
    expect: { trade: "hvac", clarifyingQuestion: true }
  },
  {
    id: "ambiguous-burning-smell-vents",
    tags: ["classification", "ambiguous"],
    say: ["I keep smelling something burning.", "It's coming out of the vents.", ...ADDRESS_TURNS],
    expect: { trade: "hvac", clarifyingQuestion: true }
  },

  // ---- Messy, realistic callers. Same answers, harder input.
  {
    id: "rambling-caller",
    tags: ["classification", "messy"],
    say: [
      "Hi, sorry, so, my wife noticed it this morning, there's like a puddle under the sink in the kitchen, and it's been getting worse all day I think, anyway can someone come out?",
      ...ADDRESS_TURNS
    ],
    expect: { trade: "plumbing", clarifyingQuestion: false }
  },
  {
    id: "two-problems-one-call",
    tags: ["classification", "messy"],
    say: [
      "The lights in my kitchen keep flickering, and honestly the AC hasn't been great either, but the lights are the urgent one.",
      ...ADDRESS_TURNS
    ],
    expect: { trade: "electrical" }
  },
  {
    id: "address-corrected-midway",
    tags: ["address"],
    say: [
      "My toilet won't stop running.",
      "It's 1203 West 8th Street, Austin, Texas, 78703.",
      "Sorry, no, it's 6th Street, not 8th. 1203 West 6th Street.",
      "Yes, that's correct."
    ],
    expect: { trade: "plumbing", addressContains: "6th" }
  },

  // ---- Error handling.
  {
    id: "error-bad-address",
    tags: ["errors"],
    say: [
      "My kitchen drain is completely blocked.",
      "It's 9 9 9 9 9 Zzzzqqq Boulevard, Nowheresville, XX, 00000.",
      "Yes that's what I said."
    ],
    expect: { trade: "plumbing", functionError: "bad_address", callSurvives: true }
  },

  // ---- Adversarial. The agent must not be talked into inventing a time.
  {
    id: "adversarial-demands-unavailable-time",
    tags: ["hallucination"],
    say: [
      "My upstairs toilet keeps running.",
      ...ADDRESS_TURNS,
      "None of those work. Can you do this Saturday at 6pm?",
      "Come on, just put me down for Saturday evening."
    ],
    expect: { trade: "plumbing", mustRefuseInventedTime: true }
  },
  {
    id: "adversarial-asks-to-book",
    tags: ["scope"],
    say: [
      "Half my house has no power.",
      ...ADDRESS_TURNS,
      "Great, book me the first one and send me a confirmation email.",
      "No, that's all."
    ],
    expect: { trade: "electrical", mustNotClaimBooked: true }
  }
];

/* ------------------------------------------------------------------ *
 * Retell driver
 * ------------------------------------------------------------------ */
async function step(messages, currentNodeId) {
  const res = await fetch(`${API}/agent-playground-completion/${AGENT_ID}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ messages, current_node_id: currentNodeId })
  });
  if (!res.ok) throw new Error(`Retell ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Run one scenario to completion and return everything we saw. */
async function runScenario(sc) {
  const history = [
    {
      role: "node_transition",
      former_node_id: "begin",
      former_node_name: "begin",
      new_node_id: "greet",
      new_node_name: "Greeting",
      transition_type: "normal"
    },
    {
      role: "agent",
      content: "Thanks for calling Ufound Mechanical, this is Emma. What's going on today?"
    }
  ];

  let node = "greet";
  const nodesVisited = ["greet"];
  const agentTurns = [];
  const toolCalls = [];
  const toolResults = [];

  for (const line of sc.say) {
    history.push({ role: "user", content: line });
    if (VERBOSE) console.log(`      caller > ${line}`);

    const out = await step(history, node);
    for (const m of out.messages) {
      history.push(m);
      if (m.role === "agent") {
        agentTurns.push(m.content);
        if (VERBOSE) console.log(`       Emma  > ${m.content}`);
      }
      if (m.role === "node_transition") nodesVisited.push(m.new_node_id);
      if (m.role === "tool_call_invocation") {
        toolCalls.push({ name: m.name, args: safeJson(m.arguments) });
      }
      if (m.role === "tool_call_result") toolResults.push(safeJson(m.content));
    }
    node = out.current_node_id || node;
    if (out.call_ended) break;
  }

  return { agentTurns, toolCalls, toolResults, nodesVisited, history };
}

const safeJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

/* ------------------------------------------------------------------ *
 * Independent slot validation — re-derives the rules, does not trust
 * the Worker's own reasoning about them.
 * ------------------------------------------------------------------ */
function nowEasternParts() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
  const p = Object.fromEntries(
    f.formatToParts(new Date()).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
  );
  const hour = p.hour === "24" ? "00" : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +hour * 60 + +p.minute };
}

function validateSlots(slots) {
  const problems = [];
  if (!Array.isArray(slots)) return ["slots is not an array"];

  const { date: today, minutes: nowMin } = nowEasternParts();
  const last = new Date(Date.parse(today + "T00:00:00Z") + (WINDOW_DAYS - 1) * 86400000)
    .toISOString().slice(0, 10);

  for (const s of slots) {
    const d = new Date(Date.parse(s.date + "T00:00:00Z"));
    const dow = d.getUTCDay();

    if (dow === 0 || dow === 6) problems.push(`${s.date} ${s.start} falls on a weekend`);
    if (s.date < today) problems.push(`${s.date} is in the past`);
    if (s.date > last) problems.push(`${s.date} is beyond the ${WINDOW_DAYS}-day window`);

    const [h, m] = s.start.split(":").map(Number);
    if (!LEGAL_START_HOURS.includes(h) || m !== 0) {
      problems.push(`${s.date} ${s.start} is not a legal slot start`);
    }
    const [eh] = s.end.split(":").map(Number);
    if (eh * 60 - h * 60 !== SLOT_MINUTES) {
      problems.push(`${s.date} ${s.start}-${s.end} is not a two-hour slot`);
    }
    if (h < 8 || eh > 16) problems.push(`${s.date} ${s.start}-${s.end} is outside 08:00-16:00`);

    if (s.date === today && h * 60 < nowMin + TODAY_CUTOFF_MINUTES) {
      problems.push(`${s.date} ${s.start} starts less than 2 hours from now`);
    }
    if (typeof s.free_minutes === "number" && s.free_minutes < 60) {
      problems.push(`${s.date} ${s.start} offered with only ${s.free_minutes} free minutes`);
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Hallucination detector
 *
 * Any clock time the agent speaks must be a real slot boundary, and any
 * weekday+ordinal it speaks must exist in the returned slots. This is the
 * check that caught the agent inventing "Friday September 4th at 9 AM,
 * 11 AM or 2 PM" inside its own talk-while-waiting message.
 * ------------------------------------------------------------------ */
const LEGAL_SPOKEN_HOURS = new Set([8, 10, 12, 2, 4, 14, 16]);
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function findInventedTimes(agentTurns, slots) {
  const found = [];
  const realDayNums = new Set((slots || []).map((s) => +s.date.slice(-2)));
  const realPairs = new Set((slots || []).map((s) => `${s.day.toLowerCase()} ${+s.date.slice(-2)}`));

  for (const turn of agentTurns) {
    const text = turn.toLowerCase();

    // "9 am", "11 a.m.", "6pm"
    for (const m of text.matchAll(/\b(\d{1,2})\s*(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)/g)) {
      const h = +m[1];
      if (!LEGAL_SPOKEN_HOURS.has(h)) found.push(`"${m[0].trim()}" is not a slot boundary`);
    }

    // "the 8th", "September 4th"
    for (const m of text.matchAll(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/g)) {
      const dayNum = +m[1];
      if (slots && slots.length && !realDayNums.has(dayNum)) {
        found.push(`offered the ${dayNum}th, which is not in slots`);
      }
    }

    // "tuesday the 8th" must exist as a pair
    for (const m of text.matchAll(
      new RegExp(`\\b(${DAYS.join("|")})\\b[^.]{0,20}?\\bthe (\\d{1,2})(?:st|nd|rd|th)\\b`, "g")
    )) {
      const pair = `${m[1]} ${+m[2]}`;
      if (slots && slots.length && !realPairs.has(pair)) {
        found.push(`"${m[0].trim()}" is not a real slot`);
      }
    }
  }
  return [...new Set(found)];
}

/* ------------------------------------------------------------------ *
 * Conversation-quality checks
 * ------------------------------------------------------------------ */
const FORBIDDEN_ASKS = [
  [/\b(your|the) name\b|who am i speaking|may i (have|get) your name/i, "asked for a name"],
  [/\bphone number\b|\bcallback number\b|\bbest number\b/i, "asked for a phone number"],
  [/\bemail\b/i, "asked for an email address"],
  [/single[- ]family|is (it|this) a (house|home|condo|apartment building)|property type/i, "asked for property type"]
];

function conversationProblems(agentTurns) {
  const problems = [];
  const first = (agentTurns[0] || "").toLowerCase();

  if (/plumbing.*(electrical|hvac)|electrical.*hvac/.test(first)) {
    problems.push("read the list of trades out loud in its first turn");
  }
  for (const [re, label] of FORBIDDEN_ASKS) {
    if (agentTurns.some((t) => re.test(t))) problems.push(label);
  }
  const wordy = agentTurns.filter((t) => t.split(/\s+/).length > 70);
  if (wordy.length) problems.push(`${wordy.length} turn(s) over 70 words — too long for a phone call`);

  return problems;
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */
function check(results, ok, label, detail) {
  results.push({ ok, label, detail });
}

async function main() {
  const chosen = ONLY ? SCENARIOS.filter((s) => s.tags.includes(ONLY) || s.id === ONLY) : SCENARIOS;
  if (!chosen.length) {
    console.error(`No scenarios match --only=${ONLY}`);
    process.exit(1);
  }

  console.log(`\nUfound voice agent — ${chosen.length} conversations against the live stack`);
  console.log(`agent ${AGENT_ID}   timezone ${TZ}\n`);

  let passed = 0, failed = 0;
  const slowest = [];

  for (const sc of chosen) {
    const started = Date.now();
    const results = [];
    let run;

    try {
      run = await runScenario(sc);
    } catch (err) {
      console.log(`  FAIL  ${sc.id}\n        ${err.message}\n`);
      failed++;
      continue;
    }

    const call = run.toolCalls.find((t) => t.name === "check_availability");
    const result = run.toolResults[0] || null;
    const slots = result && result.ok ? result.slots : [];
    const e = sc.expect;

    // --- trade
    if (e.trade) {
      check(results, call && call.args && call.args.trade === e.trade,
        `routed to ${e.trade}`,
        call ? `got "${call.args && call.args.trade}"` : "check_availability was never called");
    }

    // --- did it ask, and should it have
    if (typeof e.clarifyingQuestion === "boolean") {
      const asked = run.nodesVisited.includes("disambiguate");
      check(results, asked === e.clarifyingQuestion,
        e.clarifyingQuestion ? "asked before deciding" : "decided without asking",
        asked ? "it asked a follow-up" : "it went straight through");
    }

    // --- address
    if (e.addressContains) {
      const addr = (call && call.args && call.args.address) || "";
      check(results, addr.toLowerCase().includes(e.addressContains.toLowerCase()),
        `used the corrected address (${e.addressContains})`, `sent "${addr}"`);
    }

    // --- error path
    if (e.functionError) {
      check(results, result && result.ok === false && result.error === e.functionError,
        `returned ${e.functionError}`,
        result ? `got ok=${result.ok} error=${result.error}` : "no function result");
    }
    if (e.callSurvives) {
      check(results, run.agentTurns.length >= 2 && !/\berror\b|\bsomething went wrong\b/i.test(run.agentTurns.at(-1) || ""),
        "recovered without leaking an error at the caller",
        `last turn: "${(run.agentTurns.at(-1) || "").slice(0, 80)}"`);
    }

    // --- scope
    if (e.mustNotClaimBooked) {
      const claimed = run.agentTurns.some((t) => /\b(is )?(booked|confirmed|scheduled)\b/i.test(t) && !/will confirm|team member/i.test(t));
      check(results, !claimed, "did not claim the job was booked", "it said booked/confirmed");
    }
    if (e.mustRefuseInventedTime) {
      const caved = run.agentTurns.some((t) => /saturday|sunday/i.test(t) && /\b(6|six)\s*(p\.?m\.?)/i.test(t));
      check(results, !caved, "refused the impossible time", "it agreed to a weekend evening");
    }

    // --- always: availability correctness + hallucination + conversation
    if (result && result.ok) {
      const problems = validateSlots(slots);
      check(results, problems.length === 0, `all ${slots.length} slots obey the rules`, problems.slice(0, 3).join("; "));
    }

    const invented = findInventedTimes(run.agentTurns, slots);
    check(results, invented.length === 0, "said no time it was not given", invented.slice(0, 3).join("; "));

    const convo = conversationProblems(run.agentTurns);
    check(results, convo.length === 0, "stayed inside conversation rules", convo.join("; "));

    // --- report
    const bad = results.filter((r) => !r.ok);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    slowest.push({ id: sc.id, secs: +secs });

    if (bad.length === 0) {
      passed++;
      console.log(`  PASS  ${sc.id}  (${results.length} checks, ${secs}s)`);
    } else {
      failed++;
      console.log(`  FAIL  ${sc.id}  (${secs}s)`);
      for (const r of bad) console.log(`          ${r.label} — ${r.detail}`);
      if (!VERBOSE) {
        console.log(`        transcript:`);
        for (const t of run.agentTurns) console.log(`          Emma > ${t.slice(0, 110)}`);
      }
    }
  }

  slowest.sort((a, b) => b.secs - a.secs);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (slowest[0]) console.log(`slowest: ${slowest[0].id} at ${slowest[0].secs}s\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
