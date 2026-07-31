// ============================================================================
// NUDGE COMPOSER + RE-NUDGE STATE
//
// Builds the message text to post in a stuck thread, tagging the right POC(s)
// for the detected blocker, always cc'ing Subhang. Handles the re-nudge rule:
//   - If we already nudged a POC and they haven't replied since, re-tag the
//     SAME poc and additionally cc Sita Ram (per your instruction).
//
// State is persisted in Vercel KV so re-nudges survive across daily runs.
// Key: nudge:<channel>:<threadTs>  ->  { pocs, lastNudgeTs, count }
// ============================================================================

const { BLOCKERS, CRITICAL_SIGNALS, PEOPLE } = require("./poc-map");

function tag(id) { return `<@${id}>`; }
function tagAll(ids) { return [...new Set(ids)].map(tag).join(" "); }

// Compose the thread reply text.
function composeNudge({ analysis, isRenudge }) {
  const cc = [PEOPLE.SUBHANG];
  let pocs = [];
  let ask = "";
  let header = "";

  // Critical takes priority.
  if (analysis.critical && analysis.critical.length) {
    const key = analysis.critical[0];
    const def = CRITICAL_SIGNALS[key];
    pocs = def.pocs.slice();
    header = `:rotating_light: *${def.label}* — still open.`;
    ask = key === "lockout"
      ? "please treat as top priority and confirm next step / PX ETA. (Reminder: lockouts require a *call*, not just a tag.)"
      : "please review — customer is threatening escalation. Confirm containment + next step.";
    cc.push(PEOPLE.SITA_RAM);
  } else {
    const def = BLOCKERS[analysis.blocker] || BLOCKERS.awaiting_diagnosis;
    pocs = def.pocs.slice();
    header = `Reminder — this escalation is still open: *${def.label}*.`;
    ask = def.ask;
  }

  if (isRenudge) cc.push(PEOPLE.SITA_RAM);

  const status = analysis.one_line ? `\n> ${analysis.one_line}` : "";
  const nudgeWord = isRenudge ? "Following up again" : "Flagging";

  const text =
    `${header}${status}\n` +
    `${nudgeWord}: ${tagAll(pocs)} — ${ask}\n` +
    `cc ${tagAll(cc)}`;

  return { text, pocs, cc };
}

// --- Vercel KV / Upstash Redis state (optional; stateless if not configured) ---
// Accepts either the classic KV_REST_API_* names or the newer UPSTASH_REDIS_REST_* names.
async function kv(command, ...args) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // not configured -> stateless mode
  const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return json.result;
}

async function getNudgeState(channel, threadTs) {
  const raw = await kv("get", `nudge:${channel}:${threadTs}`);
  return raw ? JSON.parse(raw) : null;
}

async function setNudgeState(channel, threadTs, state) {
  await kv("set", `nudge:${channel}:${threadTs}`, JSON.stringify(state));
}

// Decide whether this is a re-nudge: we nudged before AND the POC we tagged
// has NOT posted a reply since our last nudge.
function isRenudge(prevState, messages) {
  if (!prevState) return false;
  const repliedSince = messages.some(
    (m) => Number(m.ts) > Number(prevState.lastNudgeTs) && prevState.pocs.includes(m.user)
  );
  return !repliedSince;
}

module.exports = { composeNudge, getNudgeState, setNudgeState, isRenudge, tagAll };
