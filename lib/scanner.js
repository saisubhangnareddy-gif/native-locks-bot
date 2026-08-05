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
const { composeNudge, extractHandoff, getNudgeState, setNudgeState, isRenudge, isAnalyzedThisCycle, markAnalyzedThisCycle, saveOpenEscalation, clearOpenEscalation, trackThread, untrackThread, getTrackedThreads } = require("./nudge");

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

    const renudge = isRenudge(prev, messages);
    // Build a name->id map for THIS thread's participants so the composer can
    // resolve the analyzer's next_actor / asked_by display names into real
    // @mentions — and ONLY ever tag people who actually posted in the thread.
    const participants = {};
    for (const m of messages) {
      if (!m.user) continue;
      const nm = nameOf(m.user);
      if (nm) participants[nm.toLowerCase().trim()] = m.user;
    }
    // Deterministic handoff extraction from the raw thread (real <@UID>
    // mentions) — this is ground truth for who was asked to act, and overrides
    // the model's next_actor when a clear "@X please Y" request exists.
    const handoffOverride = extractHandoff(messages);
    const { text, pocs, cc } = composeNudge({ analysis, isRenudge: renudge, participants, handoffOverride });
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

    results.push({ threadTs, channel, analysis, isRenudge: renudge, nudgeText: text, pocs, cc, permalink, _prevState: prev });
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
  const prevCount = (r._prevState && r._prevState.count) || 0;
  await setNudgeState(channel, r.threadTs, {
    pocs: r.pocs,
    cc: r.cc,
    lastNudgeTs: (Date.now() / 1000).toFixed(6),
    count: prevCount + 1,
    blocker: r.analysis.blocker || (r.analysis.critical && r.analysis.critical[0]) || null,
  });
}

module.exports = { scanChannel, recordNudge, DAYS };
