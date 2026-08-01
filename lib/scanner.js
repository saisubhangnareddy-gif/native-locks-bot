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
const { composeNudge, getNudgeState, setNudgeState, isRenudge } = require("./nudge");

const DAYS = Number(process.env.LOOKBACK_DAYS || 3);

async function scanChannel({ token, groqKey, model, channel }) {
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

  // Analyze ALL threads active within the window (parent may be months old, but
  // if the latest activity is within LOOKBACK_DAYS it counts). No cap — missing
  // an open thread is worse than a slightly longer run. MAX_THREADS defaults to
  // 0 (unlimited); set a positive value only as an emergency safety valve.
  const MAX_THREADS = Number(process.env.MAX_THREADS || 0);
  let activeRoots = [...threadRoots.entries()]
    .filter(([, lastTs]) => lastTs >= activeSince)
    .sort((a, b) => b[1] - a[1])
    .map(([root]) => root);
  if (MAX_THREADS > 0) activeRoots = activeRoots.slice(0, MAX_THREADS);

  // Fetch thread reply chains with limited concurrency.
  const allThreads = [];
  async function fetchRoot(root) {
    try {
      const messages = await slackClient.getThreadReplies(token, channel, root);
      if (messages && messages.length) allThreads.push({ threadTs: root, parent: messages[0], messages });
    } catch (e) {
      // Skip a single unreadable thread rather than failing the whole run.
    }
  }
  await runPool(activeRoots, 5, fetchRoot);

  const userIds = new Set();
  allThreads.forEach((t) => t.messages.forEach((m) => m.user && userIds.add(m.user)));
  const names = await slackClient.getUserNames(token, [...userIds]);
  const nameOf = (id) => names[id];

  const results = [];
  let closedCount = 0;
  let errorCount = 0;
  let lastError = null;

  async function analyzeOne({ threadTs, messages }) {
    let analysis;
    try {
      analysis = await analyzeThread({ messages, nameOf, groqKey, model });
    } catch (e) {
      errorCount++;
      lastError = String(e && e.message ? e.message : e);
      return;
    }
    if (analysis.status === "closed") { closedCount++; return; }

    const prev = await getNudgeState(channel, threadTs);
    const renudge = isRenudge(prev, messages);
    const { text, pocs, cc } = composeNudge({ analysis, isRenudge: renudge });

    results.push({
      threadTs,
      channel,
      analysis,
      isRenudge: renudge,
      nudgeText: text,
      pocs,
      cc,
      permalink: `https://urbanclap.slack.com/archives/${channel}/p${threadTs.replace(".", "")}`,
      _prevState: prev,
    });
  }
  // Analyze sequentially with light pacing to respect Groq free-tier RPM (30/min
  // => ~2s spacing is safe). Wall-clock budget stops us before a 504 as a safety
  // net; whatever is classified so far is still returned/DM'd.
  const delayMs = Number(process.env.GROQ_DELAY_MS || 2200);
  const budgetMs = Number(process.env.RUN_BUDGET_MS || 270000); // 270s < 300s limit
  const startedAt = Date.now();
  let stoppedEarly = false;
  for (let idx = 0; idx < allThreads.length; idx++) {
    if (Date.now() - startedAt > budgetMs) { stoppedEarly = true; break; }
    await analyzeOne(allThreads[idx]);
    if (idx < allThreads.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  results._stats = { fetchedThreads: allThreads.length, analyzed: closedCount + results.filter((r) => r.nudgeText).length + errorCount, closed: closedCount, open: results.filter((r) => r.nudgeText).length, errors: errorCount, stoppedEarly, lastError };
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
