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

const { BLOCKERS, CRITICAL_SIGNALS, PEOPLE, DEFAULT_CC, CRITICAL_CC, personIdForName, roleLabelForName } = require("./poc-map");

function tag(id) { return `<@${id}>`; }
function tagAll(ids) { return [...new Set(ids)].map(tag).join(" "); }

// Resolve a blocker's pocs, which may be a static array or a function(ctx).
function resolvePocs(def, ctx) {
  const p = typeof def.pocs === "function" ? def.pocs(ctx) : def.pocs;
  return Array.isArray(p) ? p.slice() : [];
}

// Compose the thread reply text. Format: SUMMARY first, then ACTIONABLE.
function composeNudge({ analysis, isRenudge, participants }) {
  let cc = DEFAULT_CC.slice(); // Subhang always
  let ask = (analysis.ask && String(analysis.ask).trim()) || "";
  const parts = participants || {};

  // Resolve a display name to a Slack ID of an ACTUAL thread participant only.
  // This is the safe resolver for handoff actors: if the model hallucinates a
  // name that never posted in the thread, this returns null (we then fall back
  // to the blocker owner) instead of fuzzy-matching it onto some POC.
  const participantId = (name) => {
    const n = (name || "").toLowerCase().trim();
    if (!n) return null;
    if (parts[n]) return parts[n];
    // Require a WORD-level overlap, not a bare substring, so "rohit" doesn't
    // match unrelated names. Both directions checked against whole words.
    const nWords = n.split(/\s+/).filter(Boolean);
    for (const key of Object.keys(parts)) {
      const kWords = key.split(/\s+/).filter(Boolean);
      const shared = nWords.some((w) => w.length >= 3 && kWords.includes(w));
      if (shared) return parts[key];
    }
    return null;
  };

  // Broader resolver (participant first, then the curated POC map). Used ONLY
  // for the no-handoff live-actor case, where a mapped POC may legitimately own
  // the next step even if the name spelling varies.
  const idForNameLoose = (name) => participantId(name) || personIdForName(name);

  const ctx = {
    sku: analysis.sku || null,
    pickupDest: (analysis.pickup_dest || "").toLowerCase() === "proms" ? "proms" : "warehouse",
    activeSme: analysis.active_sme || null,
  };

  // The REAL operational blocker always drives POC routing (even on critical
  // cases — a social-media/lockout case is still blocked on e.g. a revisit).
  const def = BLOCKERS[analysis.blocker] || BLOCKERS.awaiting_diagnosis;
  const blockerLabel = def.label;
  let pocs = resolvePocs(def, ctx);   // the SKU POC / blocker owner(s)
  if (!ask) ask = def.ask;

  // --- Who owes the next action (person B) ----------------------------------
  // RULE: whoever must ACT NEXT gets TAGGED. Everyone they unblock — the person
  // who asked (A) and the SKU POC / blocker owner — gets cc'd, along with
  // Subhang. This is how a human nudges: chase the actor, keep dependencies
  // informed so the chain clears and the issue moves toward closure.
  // next_actor may be an array of names, a single name string, or null.
  // Handoff actors are resolved against THREAD PARTICIPANTS ONLY — a name the
  // model invents (not in the thread) resolves to nothing and we fall back to
  // the blocker owner, rather than mis-tagging a POC by fuzzy name match.
  const rawActors = Array.isArray(analysis.next_actor)
    ? analysis.next_actor
    : (analysis.next_actor ? [analysis.next_actor] : []);
  const actorIdsAll = [...new Set(rawActors.map(participantId).filter(Boolean))];
  const askedById = idForNameLoose(analysis.asked_by);  // person A, or null (cc only, so loose is fine)
  const isHandoff = !!analysis.handoff;
  const nextAction = (analysis.next_action_needed && String(analysis.next_action_needed).trim()) || "";

  // Safety net against the analyzer swapping A and B: person A (the asker) must
  // NEVER be tagged to act. Also, Subhang is the standing supervisor/cc on every
  // escalation — never the field actor — so he is never tagged as next_actor
  // (the model sometimes picks him just because he posted last). Drop both; if
  // that empties the set, fall back to the blocker owner.
  const excludeFromActor = new Set([PEOPLE.SUBHANG]);
  if (askedById) excludeFromActor.add(askedById);
  const actorIds = actorIdsAll.filter((id) => !excludeFromActor.has(id));

  let primaryIds = [];   // who we @tag on the action line
  let actionAsk = ask;

  if (isHandoff && actorIds.length) {
    // Tag person(s) B (the actual named actor(s) who posted in the thread).
    // cc = owner/SKU POC + person A + Subhang.
    const ownerCc = [...pocs];
    if (askedById) ownerCc.push(askedById);
    cc = [...new Set([...cc, ...ownerCc])];

    const need = nextAction || "the pending step";
    primaryIds = [...actorIds];
    actionAsk = `please ${needAsAction(need)} to move this forward.`;
  } else if (actorIds.length && !actorIds.every((id) => pocs.includes(id))) {
    // No explicit handoff, but specific in-thread actor(s) clearly owe the next
    // step (e.g. Harshavardhan pulled Subhang in). Tag them; cc the owner.
    primaryIds = [...actorIds];
    cc = [...new Set([...cc, ...pocs])];
  } else {
    // Default (incl. handoff with only a role word / no real named actor):
    // chase the blocker owner / SKU POC with the blocker's own ask. We do NOT
    // invent a "field PX" — if no real person was named, the owner drives it.
    primaryIds = [...pocs];
  }

  // Critical is a BANNER, not the blocker. It escalates: adds the critical POCs
  // (Manuranjan + Kunal) on top, and cc's Sita Ram.
  const isCritical = !!(analysis.critical && analysis.critical.length);
  let criticalLabel = "";
  if (isCritical) {
    const def2 = CRITICAL_SIGNALS[analysis.critical[0]];
    criticalLabel = def2.label;
    pocs = [...new Set([...pocs, ...def2.pocs])];
    // Critical POCs join the chase unless specific live actor(s) already own it.
    const actorOwnsIt = actorIds.length && !actorIds.every((id) => resolvePocs(def, ctx).includes(id));
    if (!isHandoff && !actorOwnsIt) {
      primaryIds = [...pocs];
    } else {
      cc = [...new Set([...cc, ...def2.pocs])]; // keep leads cc'd when we chase the actor
    }
    cc = [...new Set([...cc, ...CRITICAL_CC])]; // Subhang + Sita Ram
  }

  // Re-nudge: cc Sita Ram even on non-critical (per instruction).
  if (isRenudge && !cc.includes(PEOPLE.SITA_RAM)) cc.push(PEOPLE.SITA_RAM);

  // Never list the same person in both the tag line and cc.
  primaryIds = [...new Set(primaryIds)];
  cc = cc.filter((id) => !primaryIds.includes(id));

  const primaryTags = tagAll(primaryIds);

  // Soft severity flag: visible note only (no banner, no critical cc).
  const softFlag = analysis.soft_flag || null;

  const followup = isRenudge ? " · _following up again, still no closure_" : "";

  const lines = [];
  // Title: critical banner if applicable, else neutral header.
  if (isCritical) lines.push(`:rotating_light: *CRITICAL — ${criticalLabel}*${followup}`);
  else lines.push(`*Escalation summary*${followup}`);
  if (analysis.issue_reported) lines.push(`• *Issue reported:* ${analysis.issue_reported}`);
  if (analysis.steps_taken) lines.push(`• *Steps so far:* ${analysis.steps_taken}`);
  lines.push(`• *Current status:* ${analysis.current_status || analysis.one_line || "—"}`);
  lines.push(`• *Blocked on:* ${blockerLabel} — ${tagAll(pocs)}`);
  if (isCritical) lines.push(`• *Priority:* critical — handle on top priority.`);
  if (softFlag) lines.push(`• *Flagged:* ${softFlag} — expedite.`);
  lines.push("");
  lines.push(`*Action needed*`);
  lines.push(`${primaryTags} ${actionAsk}`.trim());
  lines.push(`cc ${tagAll(cc)}`);
  lines.push(`_reply "resolved" here once closed so I stop nudging._`);

  return { text: lines.join("\n"), pocs, cc };
}

// Turn a noun-phrase next_action ("upload replacement invoice") into a verb
// phrase for the ask. If it already starts with a verb, leave it; otherwise
// prefix "complete" (safe for any noun) rather than assuming "share".
function needAsAction(need) {
  const n = need.trim();
  if (/^(share|upload|confirm|add|send|provide|create|align|check|update|complete|initiate|fill|punch|schedule|dispatch|deliver|replace|reset|arrange|raise|close|pick|install)\b/i.test(n)) {
    return n.charAt(0).toLowerCase() + n.slice(1);
  }
  return `complete ${n}`;
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
