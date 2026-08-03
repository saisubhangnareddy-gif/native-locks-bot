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
  let header = "";
  // Prefer the model's thread-specific ask; fall back to the blocker template.
  let ask = (analysis.ask && String(analysis.ask).trim()) || "";

  // Critical takes priority.
  if (analysis.critical && analysis.critical.length) {
    const key = analysis.critical[0];
    const def = CRITICAL_SIGNALS[key];
    pocs = def.pocs.slice();
    header = `:rotating_light: *${def.label}* — still open.`;
    if (!ask) {
      ask = key === "lockout"
        ? "please treat as top priority and confirm next step / PX ETA."
        : "please review — customer is threatening escalation. Confirm containment + next step.";
    }
    if (key === "lockout") ask += " (Reminder: lockouts require a *call*, not just a tag.)";
    cc.push(PEOPLE.SITA_RAM);
  } else {
    const def = BLOCKERS[analysis.blocker] || BLOCKERS.awaiting_diagnosis;
    pocs = def.pocs.slice();
    header = `Reminder — still open: *${def.label}*.`;
    if (!ask) ask = def.ask;
  }

  if (isRenudge) cc.push(PEOPLE.SITA_RAM);

  // Build a clean, multi-line message (fixes prior run-together formatting).
  const lines = [header];
  if (analysis.one_line) lines.push(`*Status:* ${analysis.one_line}`);
  if (analysis.last_activity) lines.push(`*Last update:* ${analysis.last_activity}`);
  const nudgeWord = isRenudge ? "Following up again" : "Flagging";
  lines.push(`${nudgeWord}: ${tagAll(pocs)} — ${ask}`);
  lines.push(`cc ${tagAll(cc)}`);

  return { text: lines.join("\n"), pocs, cc };
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

// --- Batch-cycle coverage tracking (for chunked, self-chaining runs) ---
// A "cycle" = one full sweep of all currently-active threads. We mark each
// thread analyzed with a short TTL so the next scheduled cron starts a fresh
// cycle. Within a cycle, batches skip threads already marked done.
const CYCLE_TTL = Number(process.env.CYCLE_TTL_SECONDS || 5400); // 90 min

async function isAnalyzedThisCycle(channel, threadTs) {
  const v = await kv("get", `cycle:${channel}:${threadTs}`);
  return !!v;
}

// --- Open-escalation store (so the digest can aggregate the FULL cycle without
// re-analyzing). The nudger writes one record per open thread; closed threads
// clear any stale record. The digest reads them all via the index set. ---

async function saveOpenEscalation(channel, threadTs, record) {
  await kv("set", `open:${channel}:${threadTs}`, JSON.stringify(record), "EX", String(CYCLE_TTL));
  // Maintain a Redis set of open thread ids for this channel's cycle.
  await kv("sadd", `openset:${channel}`, threadTs);
  await kv("expire", `openset:${channel}`, String(CYCLE_TTL));
}

async function clearOpenEscalation(channel, threadTs) {
  await kv("del", `open:${channel}:${threadTs}`);
  await kv("srem", `openset:${channel}`, threadTs);
}

async function getAllOpenEscalations(channel) {
  const ids = await kv("smembers", `openset:${channel}`);
  if (!ids || !ids.length) return [];
  const records = [];
  for (const ts of ids) {
    const raw = await kv("get", `open:${channel}:${ts}`);
    if (raw) { try { records.push(JSON.parse(raw)); } catch {} }
    else { await kv("srem", `openset:${channel}`, ts); } // expired -> prune
  }
  return records;
}

// --- Persistent tracking (NO expiry): once the bot nudges a thread, it stays
// tracked and re-analyzed EVERY run — even after it falls outside the 3-day
// activity window — until analysis marks it closed/resolved. Silence is exactly
// when a stuck thread most needs chasing, so we never drop a tracked thread on
// age alone. ---

async function trackThread(channel, threadTs) {
  await kv("sadd", `tracked:${channel}`, threadTs);
}

async function untrackThread(channel, threadTs) {
  await kv("srem", `tracked:${channel}`, threadTs);
}

async function getTrackedThreads(channel) {
  const ids = await kv("smembers", `tracked:${channel}`);
  return Array.isArray(ids) ? ids : [];
}

async function markAnalyzedThisCycle(channel, threadTs) {
  // SET key value EX <ttl>
  await kv("set", `cycle:${channel}:${threadTs}`, "1", "EX", String(CYCLE_TTL));
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

module.exports = { composeNudge, getNudgeState, setNudgeState, isRenudge, tagAll, isAnalyzedThisCycle, markAnalyzedThisCycle, saveOpenEscalation, clearOpenEscalation, getAllOpenEscalations, trackThread, untrackThread, getTrackedThreads };
