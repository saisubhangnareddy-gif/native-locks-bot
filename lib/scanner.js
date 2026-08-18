// ============================================================================
// SCANNER — orchestrates a full pass over a channel.
//
// 1. Pull parent messages with activity in the last N days (default 5).
// 2. For each, pull the full thread.
// 3. Analyze -> skip if closed; collect if open.
// 4. Compose nudges (re-nudge aware).
//
// Returns a structured result the endpoints turn into either:
//   - draft DM to Subhang (approval mode), or
//   - live thread posts (auto mode), and the digest.
// ============================================================================

const slackClient = require("./slack");
const { analyzeThread } = require("./stuck-detector");
const { composeNudge, getNudgeState, setNudgeState, isRenudge, isAnalyzedThisCycle, markAnalyzedThisCycle, saveOpenEscalation, clearOpenEscalation, trackThread, untrackThread, getTrackedThreads } = require("./nudge");

// Is this message the nudger bot's OWN NUDGE post? Its nudges must NOT count as
// "someone replied", or the consecutive-nudge / 3-strike logic never advances.
// Match the NUDGE TEXT SHAPE — NOT bot_id / the bot user id — because the same
// bot app also posts ESCALATION INTAKE HEADERS ("Raise a Product Issue", "POD
// escalation time", "Issue Bucket"). An intake header IS meaningful activity (a
// fresh escalation was raised), so it must count as a reply and reset the streak.
const OUR_NUDGE_RE = /(\*Action needed\*|Escalation summary|:lock: \*CRITICAL|:rotating_light: \*CRITICAL|to move this forward)/i;
const INTAKE_HEADER_RE = /\b(raise a product issue|pod escalation time|poc escalation time|issue bucket|customer request id|root request id)\b/i;
function isBotMessage(m) {
  if (!m || !m.text) return false;
  if (INTAKE_HEADER_RE.test(m.text)) return false;  // intake header — real activity
  return OUR_NUDGE_RE.test(m.text);
}

const DAYS = Number(process.env.LOOKBACK_DAYS || 3);

async function scanChannel({ token, apiKey, model, provider, channel }) {
  const now = Date.now() / 1000;
  const activeSince = now - DAYS * 86400;

  // IMPORTANT: conversations.history with `oldest` only returns PARENT messages
  // created in that window. Escalations often start weeks ago but stay active
  // via recent replies, so we must fetch parents from much further back and
  // then judge "recent activity" by each thread's latest reply, not its parent.
  const parentLookbackDays = Number(process.env.PARENT_LOOKBACK_DAYS || 60);
  const parentOldest = (now - parentLookbackDays * 86400).toFixed(6);

  const parents = await slackClient.getChannelHistory(token, channel, parentOldest);

  // Every message (root OR reply/broadcast) carries the thread's root id in
  // thread_ts; standalone roots have thread_ts === ts (or undefined). Collect
  // the UNIQUE thread roots that have ANY message within the active window,
  // then fetch each root's full reply chain once. This captures old-but-active
  // escalations that history would otherwise scatter across broadcast rows.
  const threadRoots = new Map(); // rootTs -> most recent activity ts seen
  for (const m of parents) {
    if (m.type !== "message") continue;
    if (!m.ts || !/^\d+\.\d+$/.test(m.ts)) continue;
    const root = m.thread_ts && /^\d+\.\d+$/.test(m.thread_ts) ? m.thread_ts : m.ts;
    // recency signal for THIS row = latest_reply (if root) or its own ts
    const rowLast = Number(m.latest_reply || m.ts);
    const prev = threadRoots.get(root) || 0;
    if (rowLast > prev) threadRoots.set(root, rowLast);
  }

  // Candidate roots = (threads active within the 3-day window) UNION (threads
  // the bot is already tracking from prior nudges). Tracked threads are always
  // re-checked regardless of age, so a stuck thread that goes silent past 3
  // days keeps getting nudged until it's marked resolved.
  const activeSet = [...threadRoots.entries()]
    .filter(([, lastTs]) => lastTs >= activeSince)
    .sort((a, b) => b[1] - a[1])
    .map(([root]) => root);

  let tracked = [];
  try { tracked = await getTrackedThreads(channel); } catch {}
  // Merge, preserving recency order; tracked-but-inactive appended after.
  const seen = new Set(activeSet);
  const activeRoots = activeSet.concat(tracked.filter((t) => !seen.has(t)));
  const totalActive = activeRoots.length;

  // Skip roots already analyzed this cycle, then cap to a SMALL per-run batch
  // so each call finishes inside the scheduler's request timeout (~30-40s).
  // cron-job.org calls this every few minutes, so small batches add up to full
  // coverage. Whatever we can't reach stays pending for the next call.
  const pendingAll = [];
  for (const root of activeRoots) {
    if (await isAnalyzedThisCycle(channel, root)) continue;
    pendingAll.push(root);
  }
  const RUN_MAX = Number(process.env.RUN_MAX_THREADS || 3);
  const pending = pendingAll.slice(0, RUN_MAX);

  // Runs are ~5 min apart (separate TPM windows), so only a light in-run pace is
  // needed. 3 threads ≈ 4.5K tokens < 6K TPM, and the whole run finishes in
  // ~30s — inside the scheduler's request timeout.
  const paceMs = Number(process.env.GROQ_PACE_MS || 3000);
  const budgetMs = Number(process.env.RUN_BUDGET_MS || 40000); // finish within scheduler timeout
  const startedAt = Date.now();

  const results = [];
  let closedCount = 0;
  let errorCount = 0;
  let analyzedCount = 0;
  let skippedCooldown = 0;
  let lastError = null;
  let stoppedEarly = false;

  // Resolve display names lazily per-thread (cache across the run).
  const nameCache = {};
  async function nameOfCached(ids) {
    const missing = ids.filter((id) => id && !(id in nameCache));
    if (missing.length) Object.assign(nameCache, await slackClient.getUserNames(token, missing));
    return (id) => nameCache[id];
  }

  // Minimum gap between two nudges to the SAME thread. This guarantees ONE
  // nudge per run-window: within a continuous every-minute sweep we never
  // re-nudge, and a re-nudge only happens in a LATER window (9am vs 4pm are 7h
  // apart, so a 4h cooldown lets each window fire once). Prevents the "nudged at
  // 2:30, re-nudged at 2:32" bug.
  const nudgeCooldownMs = Number(process.env.NUDGE_COOLDOWN_HOURS || 4) * 3600 * 1000;

  async function analyzeOne({ threadTs, messages }, nameOf) {
    // Cooldown guard FIRST — if we nudged this thread recently, skip it entirely
    // this run (no analyze, no post). Cheap and saves an LLM call.
    const prev = await getNudgeState(channel, threadTs);
    if (prev && prev.lastNudgeTs) {
      const sinceMs = Date.now() - Number(prev.lastNudgeTs) * 1000;
      if (sinceMs < nudgeCooldownMs) { skippedCooldown++; return; }
    }

    let analysis;
    try {
      analysis = await analyzeThread({ messages, nameOf, apiKey, model, provider });
    } catch (e) {
      errorCount++;
      lastError = String(e && e.message ? e.message : e);
      return;
    }
    if (analysis.status === "closed") {
      closedCount++;
      try { await clearOpenEscalation(channel, threadTs); } catch {}
      try { await untrackThread(channel, threadTs); } catch {}
      return;
    }
    // "parked": e.g. replacement/return sheet filled and warehouse now handles
    // dispatch — nothing to nudge until a LATER message raises a new blocker.
    // Do NOT nudge and drop it from the digest, but KEEP it tracked so if the
    // thread moves again (not delivered / install pending) we re-analyze it.
    if (analysis.status === "parked") {
      try { await clearOpenEscalation(channel, threadTs); } catch {}
      return;
    }

    const renudge = isRenudge(prev, messages);
    // CONSECUTIVE nudge = we nudged before AND NO human message of ANY kind has
    // been posted since our last nudge (a clean back-to-back nudge). Stricter
    // than isRenudge (which only checks the tagged POC): here ANYONE posting in
    // between breaks the streak. Drives the action-only (no-summary) re-nudge so
    // it applies ONLY when the thread has been silent since our last nudge.
    let consecutiveNoMsg = false;
    if (prev && prev.lastNudgeTs) {
      // "Did anyone reply since our last nudge?" — EXCLUDING the bot's own nudge
      // posts (auto mode posts into the thread; those must not count as activity).
      const humanSince = messages.some(
        (m) => m.user && Number(m.ts) > Number(prev.lastNudgeTs) && !isBotMessage(m)
      );
      consecutiveNoMsg = !humanSince;
    }
    // 3-STRIKE STOP: if we've sent MAX_UNANSWERED consecutive nudges with NO
    // message from ANYONE in between (thread fully silent since our nudges), stop
    // nudging — it's likely resolved offline or pending something on the ground
    // (transit / Tech RCA). We resume only when someone posts again (which breaks
    // consecutiveNoMsg and resets the streak in recordNudge). Keep it tracked +
    // out of the digest while silenced.
    const MAX_UNANSWERED = Number(process.env.MAX_UNANSWERED_NUDGES || 3);
    const priorStreak = prev ? Number(prev.consecutiveNoReply || 0) : 0;
    if (consecutiveNoMsg && priorStreak >= MAX_UNANSWERED) {
      skippedCooldown++; // (reuse the skip counter for stats; not a real nudge)
      return;
    }
    // Build a name->id map for THIS thread's participants so the composer can
    // resolve the analyzer's next_actor / asked_by display names into real
    // @mentions — and ONLY ever tag people who actually posted in the thread.
    // BLOCKED people (e.g. Titas Dewan — moved off this workstream) are captured
    // by id here so the composer can strip them from tags AND cc everywhere.
    const participants = {};
    const blockedIds = [];
    const BLOCK_NAMES = ["titas"];
    for (const m of messages) {
      if (!m.user) continue;
      const nm = nameOf(m.user);
      if (!nm) continue;
      const low = nm.toLowerCase().trim();
      if (BLOCK_NAMES.some((b) => low.includes(b))) { blockedIds.push(m.user); continue; }
      participants[low] = m.user;
    }
    const { text, pocs, cc } = composeNudge({ analysis, isRenudge: renudge, actionOnly: consecutiveNoMsg, participants, messages, blockedIds });
    const permalink = `https://urbanclap.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;

    try {
      await saveOpenEscalation(channel, threadTs, {
        threadTs, permalink,
        blocker: analysis.blocker || null,
        critical: analysis.critical || null,
        one_line: analysis.one_line || analysis.current_status || "",
        last_activity: analysis.last_activity || "",
        pocs,
      });
    } catch {}
    try { await trackThread(channel, threadTs); } catch {}

    results.push({ threadTs, channel, analysis, isRenudge: renudge, consecutiveNoMsg, nudgeText: text, pocs, cc, permalink, _prevState: prev });
  }

  let processed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (Date.now() - startedAt > budgetMs) { stoppedEarly = true; break; }
    const root = pending[i];
    let messages;
    try {
      messages = await slackClient.getThreadReplies(token, channel, root);
    } catch { continue; }
    if (!messages || !messages.length) { try { await markAnalyzedThisCycle(channel, root); } catch {}; continue; }

    const ids = [...new Set(messages.map((m) => m.user).filter(Boolean))];
    const nameOf = await nameOfCached(ids);

    // Staleness cap: a tracked thread with NO new message for STALE_DAYS is
    // dead or being handled offline — stop nudging it (untrack + drop from
    // digest). Persistent tracking chases silence, but not indefinitely; if the
    // thread moves again it re-enters via the active window.
    const staleDays = Number(process.env.STALE_DAYS || 7);
    const lastMsgTs = Math.max(...messages.map((m) => Number(m.ts) || 0));
    if (lastMsgTs && (Date.now() / 1000 - lastMsgTs) > staleDays * 86400) {
      try { await clearOpenEscalation(channel, root); } catch {}
      try { await untrackThread(channel, root); } catch {}
      try { await markAnalyzedThisCycle(channel, root); } catch {}
      continue;
    }

    analyzedCount++;
    await analyzeOne({ threadTs: root, messages }, nameOf);
    try { await markAnalyzedThisCycle(channel, root); } catch {}
    processed++;
    if (i < pending.length - 1 && Date.now() - startedAt <= budgetMs) {
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }

  // Remaining across the WHOLE cycle = everything not yet analyzed minus what
  // this run just processed (not just this small batch).
  const remaining = Math.max(0, pendingAll.length - processed);

  results._stats = {
    totalActive,
    pendingTotal: pendingAll.length,
    batch: pending.length,
    analyzed: analyzedCount,
    closed: closedCount,
    skippedCooldown,
    open: results.filter((r) => r.nudgeText).length,
    errors: errorCount,
    stoppedEarly,
    remaining,
    cycleComplete: remaining === 0,
    lastError,
  };
  return results;
}

// Run an async worker over items with a fixed concurrency limit.
async function runPool(items, concurrency, worker) {
  let i = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

// Persist that we nudged (called only when a nudge is actually posted/approved).
async function recordNudge(channel, r) {
  const prev = r._prevState || {};
  const prevCount = prev.count || 0;
  const priorStreak = Number(prev.consecutiveNoReply || 0);
  // consecutiveNoReply = number of nudges in a row with NO message from ANYONE
  // in between (thread fully silent since our last nudge). A silent consecutive
  // nudge extends the streak; ANY message from anyone since our last nudge (a
  // fresh nudge) resets it to 1. This drives the 3-strike stop in analyzeOne.
  const consecutiveNoReply = r.consecutiveNoMsg ? priorStreak + 1 : 1;
  await setNudgeState(channel, r.threadTs, {
    pocs: r.pocs,
    cc: r.cc,
    lastNudgeTs: (Date.now() / 1000).toFixed(6),
    count: prevCount + 1,
    consecutiveNoReply,
    blocker: r.analysis.blocker || (r.analysis.critical && r.analysis.critical[0]) || null,
  });
}

module.exports = { scanChannel, recordNudge, DAYS };
