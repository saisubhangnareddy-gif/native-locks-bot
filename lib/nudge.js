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

const { BLOCKERS, CRITICAL_SIGNALS, PEOPLE, DEFAULT_CC, CRITICAL_CC, personIdForName, roleLabelForName, rcaPocsForSku, nameById } = require("./poc-map");

function tag(id) { return `<@${id}>`; }
function tagAll(ids) { return [...new Set(ids)].map(tag).join(" "); }
// Plain display names (no @mention) for the "Blocked on" row.
function namesOf(ids) {
  return [...new Set(ids)].map((id) => nameById(id) || "someone").join(", ");
}

// Resolve a blocker's pocs, which may be a static array or a function(ctx).
function resolvePocs(def, ctx) {
  const p = typeof def.pocs === "function" ? def.pocs(ctx) : def.pocs;
  return Array.isArray(p) ? p.slice() : [];
}

// --- NARROW TAIL HANDOFF EXTRACTOR --------------------------------------------
// Deliberately conservative: looks ONLY at the last few messages, and only fires
// on an unambiguous "@X please/kindly/pls <request>" line. Returns the addressed
// Slack IDs (person B) and the author (person A). Excludes Engineering, Subhang,
// and the author themselves. Returns null if the tail has no clear request — in
// which case we defer entirely to the model's next_actor. This targets the
// recurring "@Padmanabhan align...", "@Sindhu create revisit", "@Sneha share"
// misses without the old extractor's deep-history / blunt-override problems.
// A message counts as a request if it has a politeness cue, a bare imperative
// after a mention, OR a direct status-chase question at a mention ("@X when will
// cx be available", "@X any update"). Kept tight to avoid false positives.
const TAIL_REQUEST = /\b(please|pls|plz|pls\.|kindly|need you to|needs to|we need to|can you|could you|requesting you|request you|kindly help|when will|when can|any update|provide an update|share an update|please update|update here|update on this)\b/i;
// Bare imperative: a mention followed (optionally via a filler like "plz"/"sir")
// by an action verb.
const TAIL_IMPERATIVE = /<@[A-Z0-9]+>[\s,:-]*(?:plz|pls|please|kindly|sir|ji|maam|ma'am)?[\s,:-]*(create|align|share|fill|check|update|initiate|punch|schedule|dispatch|deliver|replace|reset|arrange|raise|connect|confirm|pick|install|send|add|coordinate|complete)\b/i;
// Requests that are NOT a real actionable handoff (withdrawal / no-op).
const TAIL_NONACTION = /\b(ignore|no need|nvm|never ?mind|disregard|use (the )?portal|raise .*(from|on) .*(portal|dashboard)|guide .*(portal|agent)|strictly raise)\b/i;
// A COMPLETION-REPORT addressed to a POC ("@X visit created for flashing",
// "@X revisit done", "@X sheet filled row 12") hands the ball BACK to X to
// verify/validate — even without a "please". We detect it separately so the
// tagged actor is the ADDRESSED POC and the action is a validation ask, not a
// copy of the completion line.
const TAIL_COMPLETION = /<@[A-Z0-9]+>[\s,:-]*(?:sir|ji)?[\s,:-]*(visit|revisit|installation)\s+(created|done|scheduled|completed|aligned)\b/i;
const TAIL_LOOKBACK = 5;
function extractTailHandoff(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const start = Math.max(0, messages.length - TAIL_LOOKBACK);
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    const text = (m.text || "").trim();
    if (!text) continue;
    // Completion-report handoff: "@X visit created / revisit done" hands back to
    // the addressed POC to validate. Handle BEFORE the request check so it isn't
    // missed for lacking a "please".
    const completion = TAIL_COMPLETION.test(text);
    const isRequest = TAIL_REQUEST.test(text) || TAIL_IMPERATIVE.test(text) || completion;
    if (!isRequest) continue;
    if (TAIL_NONACTION.test(text)) continue;   // "please ignore" etc. — not a handoff
    const mentions = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((x) => x[1]);
    if (!mentions.length) continue;
    const EXCLUDE = new Set([PEOPLE.SUBHANG, PEOPLE.SITA_RAM, PEOPLE.KUNAL, PEOPLE.ABHIRAM, PEOPLE.GAGAN, m.user]);
    const actorIds = [...new Set(mentions.filter((id) => !EXCLUDE.has(id)))];
    if (!actorIds.length) continue;
    // Completion-report: the addressed POC validates — canned validation action,
    // never a copy of the "visit created" line.
    if (completion) {
      return { actorIds, askedById: m.user || null, action: "confirm the visit is scheduled and validate it resolves the customer's issue" };
    }
    // Pull the ACTION text from THIS SAME line. Prefer the clause after a
    // politeness cue; else take the imperative clause right after the mention.
    let action = "";
    let pm = text.match(/\b(?:please|pls|plz|kindly|need you to|needs to|we need to|can you|could you|requesting you|request you)\b[\s,:-]*([^\n.]{3,140})/i);
    if (!pm) pm = text.match(/<@[A-Z0-9]+>[\s,:-]*(?:plz|pls|please|kindly|sir|ji|maam|ma'am)?[\s,:-]*((?:create|align|share|fill|check|update|initiate|punch|schedule|dispatch|deliver|replace|reset|arrange|raise|connect|confirm|pick|install|send|add|coordinate|complete)\b[^\n.]{0,140})/i);
    if (pm && pm[1]) {
      action = pm[1]
        .replace(/<@[A-Z0-9]+>/g, "")           // strip any residual mentions
        .replace(/\bcc[:\-\s].*$/i, "")          // drop trailing "cc ..."
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    // Status-chase questions ("@X when will cx be available", "@X any update")
    // don't yield a clean action clause — use a canned, sensible instruction.
    if (!action && /\b(when will|when can|any update|provide an update|share an update|please update|update here|update on this)\b/i.test(text)) {
      action = "connect with the customer, get an update, and share the next step / ETA";
    }
    return { actorIds, askedById: m.user || null, action };
  }
  return null;
}

// Compose the thread reply text. Format: SUMMARY first, then ACTIONABLE.
// `messages` (optional) enables the narrow tail-handoff extractor.
// `blockedIds` are people who must never appear anywhere (e.g. Titas Dewan).
function composeNudge({ analysis, isRenudge, participants, messages, blockedIds }) {
  let cc = DEFAULT_CC.slice(); // Subhang always
  let ask = (analysis.ask && String(analysis.ask).trim()) || "";
  const parts = participants || {};
  const blocked = new Set(blockedIds || []);

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

  // Code-level Proms override: if Padmanabhan actually posted in this thread OR
  // is a resolved handoff actor, the item is going to/from Proms — force proms
  // routing regardless of what the model set pickup_dest to. Padmanabhan only
  // ever appears for Proms alignment/pickup, so his presence is a reliable
  // signal the model keeps missing.
  const padmanabhanInThread = Object.values(parts).includes(PEOPLE.PADMANABHAN);
  if (padmanabhanInThread) ctx.pickupDest = "proms";

  // The REAL operational blocker always drives POC routing (even on critical
  // cases — a social-media/lockout case is still blocked on e.g. a revisit).
  const def = BLOCKERS[analysis.blocker] || BLOCKERS.awaiting_diagnosis;
  const blockerLabel = def.label;
  let pocs = resolvePocs(def, ctx);   // the SKU POC / blocker owner(s)
  if (!ask) ask = def.ask;

  // --- Who owes the next action (person B) ----------------------------------
  // Prefer the NARROW TAIL EXTRACTOR (real <@UID> from a clear recent "@X please
  // Y" line) — it reliably catches "@Padmanabhan align", "@Sindhu create revisit",
  // "@Sneha share" that the model keeps missing. If the tail has no clear request,
  // defer to the model's next_actor. Names resolve against thread participants
  // only, so a hallucinated model name falls back to the blocker owner.
  // On near_closure we do NOT run the tail extractor — the pending step is just
  // "confirm it's resolved", owned by the SKU POC, not whatever earlier "@X
  // create revisit" line the tail might grab.
  const tail = analysis.near_closure ? null : extractTailHandoff(messages);
  const modelActorIds = [...new Set(
    (Array.isArray(analysis.next_actor) ? analysis.next_actor
      : (analysis.next_actor ? [analysis.next_actor] : [])
    ).map(participantId).filter(Boolean)
  )];
  const actorIdsAll = tail ? [...tail.actorIds] : modelActorIds;
  const askedById = tail ? tail.askedById : idForNameLoose(analysis.asked_by);
  const isHandoff = tail ? true : !!analysis.handoff;
  // ASK source:
  //   • Tail fired → the ask describes the TAIL line's step (the current handoff),
  //     cleaned via cleanRawAction so it isn't a rambling copy. This keeps tag and
  //     ask COHERENT (both from the same latest request) and CURRENT (avoids the
  //     model anchoring on a stale earlier phase, e.g. "audit revisit" when the
  //     newest line was "connect with cx and check the reset"). Falls back to the
  //     model's action only if the cleaned tail action is empty/too short.
  //   • Tail did NOT fire → model action (an intelligent reframe of the current step).
  const modelAction = (analysis.next_action_needed && String(analysis.next_action_needed).trim()) || "";
  const cleanedTail = tail ? cleanRawAction(tail.action) : "";
  const nextAction = tail
    ? (cleanedTail.length >= 6 ? cleanedTail : modelAction)
    : modelAction;

  // Safety net against the analyzer swapping A and B: person A (the asker) must
  // NEVER be tagged to act. Also, Subhang is the standing supervisor/cc on every
  // escalation — never the field actor. And Engineering (Abhiram/Gagan) must
  // NEVER be tagged as a handoff actor — a POC pinging them is a consult; they
  // are only ever tagged via their own blocker (deep_firmware_rca / entity_reset,
  // which route through `pocs`). Drop all these; if the actor set empties, we
  // fall back to the blocker owner.
  const excludeFromActor = new Set([PEOPLE.SUBHANG, PEOPLE.SITA_RAM, PEOPLE.KUNAL, PEOPLE.ABHIRAM, PEOPLE.GAGAN, ...blocked]);
  if (askedById) excludeFromActor.add(askedById);
  const actorIds = actorIdsAll.filter((id) => !excludeFromActor.has(id));

  let primaryIds = [];   // who we @tag on the action line
  let actionAsk = ask;

  if (isHandoff && actorIds.length) {
    // Tag person(s) B (the actual named actor(s) who posted in the thread).
    primaryIds = [...actorIds];
    const need = nextAction || "";
    actionAsk = needAsAction(need);
  } else if (actorIds.length && !actorIds.every((id) => pocs.includes(id))) {
    // No explicit handoff, but specific in-thread actor(s) clearly owe the next
    // step (e.g. Harshavardhan pulled Subhang in). Tag them.
    primaryIds = [...actorIds];
  } else {
    // Default (incl. handoff with only a role word / no real named actor):
    // chase the blocker owner / SKU POC with the blocker's own ask. We do NOT
    // invent a "field PX" — if no real person was named, the owner drives it.
    primaryIds = [...pocs];
  }

  // Set of all mapped POC/logistics/SME ids (used to tell "real owner" from
  // an escalation agent below).
  const mappedIds = new Set(Object.values(PEOPLE));

  // For Engineering RCA blockers (deep_firmware_rca / entity_reset): while the
  // case is genuinely WAITING on Engineering, force the tag to the blocker POC
  // (Abhiram / Gagan) with the clean standard ask. A later handoff overrides
  // this ONLY if it's to a mapped OPERATIONAL owner (POC / logistics) doing a
  // real post-RCA step (e.g. "@Padmanabhan align battery", "@Rushali connect
  // with cx"). If the tail actor is an AGENT (not mapped), it is NOT a genuine
  // RCA-owner handoff — an agent can't "complete a firmware RCA" — so we still
  // force Engineering. This stops "@Yuvraj please complete the firmware RCA".
  const tailActorMapped = tail && tail.actorIds && tail.actorIds.some((id) => mappedIds.has(id));
  if ((analysis.blocker === "deep_firmware_rca" || analysis.blocker === "entity_reset") && !tailActorMapped) {
    primaryIds = [...pocs];   // pocs = [Abhiram] or [Gagan] for these blockers
    actionAsk = def.ask;
  }

  // Fresh escalation with NO real handoff (nobody was asked to do a specific
  // step yet): tag ONLY the diagnosis owners from the blocker (SKU RCA POC +
  // Manuranjan) — never the escalation-header secondary POCs or a random agent
  // the model may have surfaced. If a genuine handoff (tail) fired, that wins.
  if (analysis.blocker === "awaiting_diagnosis" && !tail) {
    primaryIds = [...pocs];
    actionAsk = def.ask;
  }

  // Diagnostic tasks belong to POCs, never agents. If the action is a
  // diagnosis/RCA task ("check the debugger", "check logs", "run RCA",
  // "analyse") but the tagged person is NOT a mapped POC (i.e. an escalation
  // agent the model/tail surfaced), reassign the tag to the SKU RCA owner. An
  // agent can't "check the debugger".
  const DIAGNOSTIC_ASK = /\b(debugger|check .*logs?|\brca\b|analyse|analyze|root cause|firmware|mpcb)\b/i;
  if (DIAGNOSTIC_ASK.test(actionAsk) && primaryIds.length && !primaryIds.some((id) => mappedIds.has(id))) {
    primaryIds = rcaPocsForSku(ctx.sku);
    actionAsk = "the RCA is still open — could you confirm the root cause and the next step, with an ETA?";
  }

  // --- cc composition — the SUPERVISORY / TRACKING layer ONLY:
  //   • SKU POC(s) — Jyothi+Harsha (Pro), Harsha (Ultra) — they track issues.
  //   • Subhang — supervises POCs + POD.
  //   • (critical only) Kunal + Sita Ram — supervise POD, added in the critical
  //     block below.
  // People who PERFORM actions (agents, logistics like Padmanabhan/Sharvan/Rohit,
  // SMEs, Manuranjan, Engineering) are NEVER cc'd just for having posted — once
  // their action is done they drop off. They only appear when TAGGED as the
  // current actor (primary), not in cc. Anyone who is the primary tag is removed
  // from cc later so nobody appears twice.
  const skuPocs = rcaPocsForSku(ctx.sku);
  cc = [...new Set([...DEFAULT_CC, ...skuPocs])];

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
    }
    // Critical supervisory cc: Sita Ram + Kunal (both supervise POD). Subhang is
    // already in DEFAULT_CC. If either ends up as the primary tag, the dedupe
    // below removes them from cc.
    cc = [...new Set([...cc, ...CRITICAL_CC, PEOPLE.KUNAL])];
  }

  // Sita Ram is cc'd ONLY on critical cases — never on re-nudges or anywhere
  // else. (Previously a re-nudge added him; that was wrong.)
  if (!isCritical) cc = cc.filter((id) => id !== PEOPLE.SITA_RAM);

  // Engineering (Gagan / Abhiram) are cc'd ONLY when the issue is actively
  // blocked on them — in which case they're the tagged primary, not cc. They
  // must never linger in cc for later nudges once they've replied. So strip
  // them from cc unless they're the current primary tag.
  const ENGINEERING = [PEOPLE.GAGAN, PEOPLE.ABHIRAM];
  cc = cc.filter((id) => !ENGINEERING.includes(id) || primaryIds.includes(id));

  // Never list the same person in both the tag line and cc. Also strip any
  // blocked people (e.g. Titas) from cc — they never appear anywhere.
  primaryIds = [...new Set(primaryIds)].filter((id) => !blocked.has(id));
  cc = cc.filter((id) => !primaryIds.includes(id) && !blocked.has(id));

  const primaryTags = tagAll(primaryIds);

  // Near closure: the fix looks applied and only confirmation remains. The
  // action itself becomes a genuine "is this resolved?" — a real ops question,
  // NOT a meta-instruction about stopping the bot.
  if (analysis.near_closure) {
    actionAsk = "the fix looks complete on our side — can you confirm with the customer that this is now resolved and working?";
  }

  // Soft severity flag: visible note only (no banner, no critical cc).
  const softFlag = analysis.soft_flag || null;

  const followup = isRenudge ? " · _following up again, still no closure_" : "";

  // Clean SKU label for the header (e.g. "Lock Pro", "Lock Ultra", "Lock S").
  const skuLabel = skuLabelOf(analysis.sku);
  const skuTag = skuLabel ? ` (${skuLabel})` : "";

  const lines = [];
  // Title: critical banner if applicable, else neutral header. SKU appended.
  // Distinct emoji per critical type: :lock: for lockout, :rotating_light: for
  // social-media/legal.
  if (isCritical) {
    const critEmoji = analysis.critical[0] === "lockout" ? ":lock:" : ":rotating_light:";
    lines.push(`${critEmoji} *CRITICAL — ${criticalLabel}*${skuTag}${followup}`);
  } else lines.push(`*Escalation summary${skuTag}*${followup}`);
  if (analysis.issue_reported) lines.push(`• *Issue reported:* ${analysis.issue_reported}`);
  if (analysis.steps_taken) lines.push(`• *Steps so far:* ${analysis.steps_taken}`);
  lines.push(`• *Current status:* ${analysis.current_status || analysis.one_line || "—"}`);
  lines.push(`• *Blocked on:* ${blockerLabel} — ${namesOf(pocs)}`);
  if (isCritical) lines.push(`• *Priority:* critical — handle on top priority.`);
  if (softFlag) lines.push(`• *Flagged:* ${softFlag} — expedite.`);
  lines.push("");
  lines.push(`*Action needed*`);
  // Final sanitizer: collapse a doubled "to move this forward" tail, and fix
  // broken "share an update on <be/is/are/been> ..." fragments that arise when a
  // mid-sentence clause got captured. Keep it a single clean sentence.
  let finalAsk = actionAsk
    .replace(/\bto move\s+(to move this forward\.?)/i, "$1")
    .replace(/(to move this forward\.?)(\s*to move this forward\.?)+/i, "$1")
    .replace(/\bshare an update on (be|is|are|been|being)\b/i, "share an update on the pending step —")
    .replace(/\s{2,}/g, " ")
    .trim();
  lines.push(`${primaryTags} ${finalAsk}`.trim());
  lines.push(`cc ${tagAll(cc)}`);

  return { text: lines.join("\n"), pocs, cc };
}

// Normalize the analyzer's free-text sku into a short header label:
// "Native Lock Pro • Grey" -> "Lock Pro"; "NATIVE LOCK ULTRA" -> "Lock Ultra";
// "Native Lock S" -> "Lock S". Returns "" if no confident SKU.
function skuLabelOf(sku) {
  const s = (sku || "").toLowerCase();
  if (!s) return "";
  if (s.includes("ultra")) return "Lock Ultra";
  if (s.includes("pro")) return "Lock Pro";
  // "Native Lock S" / "Lock S" — standalone S variant.
  if (/\block\s*s\b/.test(s) || /\bnative lock s\b/.test(s)) return "Lock S";
  if (s.includes("lock")) return "Lock"; // generic/older SKU, still show something
  return "";
}


// "complete discuss the concern", we do NOT prepend a verb. If the phrase is
// already imperative (starts with a verb), use it as a standalone sentence
// ("Please <phrase>."). Otherwise treat it as a noun phrase describing what's
// pending ("Please share an update on <phrase>.").
const ACTION_VERBS = /^(share|upload|confirm|add|send|provide|create|align|check|update|complete|initiate|fill|punch|schedule|dispatch|deliver|replace|reset|arrange|raise|close|pick|install|connect|discuss|resolve|cancel|approve|inform|verify|coordinate|escalate|follow|help)\b/i;
function needAsAction(need) {
  const n = (need || "").trim().replace(/[.\s]+$/, "");  // strip trailing period/space
  if (!n) return "please share an update / the next step and ETA to move this forward.";
  if (ACTION_VERBS.test(n)) {
    return `please ${n.charAt(0).toLowerCase() + n.slice(1)} to move this forward.`;
  }
  return `please share an update on ${n} (next step + ETA) to move this forward.`;
}

// Sanitize a RAW thread line used as a last-resort action fallback: trim to the
// first clause, drop rambling customer VOC, cap length. Keeps the fallback from
// pasting a whole sentence into the nudge.
function cleanRawAction(s) {
  let n = (s || "").trim();
  if (!n) return "";
  // Cut at the first sentence-ish boundary or filler connector.
  n = n.split(/[.;\n]|(?:\bbut\b|\band cx\b|\bas cx\b|\bbecause\b|\bplease help\b)/i)[0].trim();
  if (n.length > 90) n = n.slice(0, 90).trim();
  return n;
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
