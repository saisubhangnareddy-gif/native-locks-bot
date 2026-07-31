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

const DAYS = Number(process.env.LOOKBACK_DAYS || 5);

async function scanChannel({ token, geminiKey, model, channel }) {
  const now = Date.now() / 1000;
  const activeSince = now - DAYS * 86400;

  // IMPORTANT: conversations.history with `oldest` only returns PARENT messages
  // created in that window. Escalations often start weeks ago but stay active
  // via recent replies, so we must fetch parents from much further back and
  // then judge "recent activity" by each thread's latest reply, not its parent.
  const parentLookbackDays = Number(process.env.PARENT_LOOKBACK_DAYS || 60);
  const parentOldest = (now - parentLookbackDays * 86400).toFixed(6);

  const parents = await slackClient.getChannelHistory(token, channel, parentOldest);

  // Candidate = a real message whose thread has activity within the window.
  // latest_reply (if threaded) or its own ts must be >= activeSince.
  const candidates = parents.filter((m) => {
    if (m.type !== "message") return false;
    if (m.subtype && m.subtype !== "bot_message" && m.subtype !== "thread_broadcast") return false;
    if (!m.ts || !/^\d+\.\d+$/.test(m.ts)) return false;
    // Only consider thread parents (a reply carries thread_ts != ts); parents
    // returned by history are the roots. Recency = latest_reply or own ts.
    const lastTs = Number(m.latest_reply || m.ts);
    return lastTs >= activeSince;
  });

  // Collect all user IDs up front for name resolution.
  const allThreads = [];
  for (const parent of candidates) {
    const threadTs = parent.thread_ts || parent.ts;
    if (!threadTs || !/^\d+\.\d+$/.test(threadTs)) continue;
    try {
      const messages = await slackClient.getThreadReplies(token, channel, threadTs);
      if (messages && messages.length) allThreads.push({ threadTs, parent, messages });
    } catch (e) {
      // Skip a single unreadable thread rather than failing the whole run.
      continue;
    }
  }

  const userIds = new Set();
  allThreads.forEach((t) => t.messages.forEach((m) => m.user && userIds.add(m.user)));
  const names = await slackClient.getUserNames(token, [...userIds]);
  const nameOf = (id) => names[id];

  const results = [];
  let closedCount = 0;
  for (const { threadTs, parent, messages } of allThreads) {
    let analysis;
    try {
      analysis = await analyzeThread({ messages, nameOf, geminiKey, model });
    } catch (e) {
      results.push({ threadTs, error: String(e), permalink: null });
      continue;
    }
    if (analysis.status === "closed") { closedCount++; continue; } // resolved -> no nudge

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
  results._stats = { fetchedThreads: allThreads.length, closed: closedCount, open: results.filter((r) => r.nudgeText).length };
  return results;
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
