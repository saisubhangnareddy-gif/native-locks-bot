// ============================================================================
// /api/nudge — the per-thread nudger (SHORT-RUN design).
//
// Each call analyzes a small batch of pending threads (fits inside a scheduler
// timeout, ~30-40s), sends the summary→actionable nudge, and returns normally.
// Threads it can't reach stay pending in KV. cron-job.org calls this every few
// minutes, so the small batches add up to full coverage across the window.
//
// Modes (env NUDGE_MODE): "draft" (DM Subhang) | "auto" (post in-channel).
// Secured by CRON_SECRET (?key= or Bearer header).
// ============================================================================

const { scanChannel, recordNudge } = require("../lib/scanner");
const slackClient = require("../lib/slack");
const { analyzeThread } = require("../lib/stuck-detector");
const { composeNudge, getNudgeState, isRenudge } = require("../lib/nudge");
const { PEOPLE } = require("../lib/poc-map");

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers["authorization"] || "";
  const key = (req.query && req.query.key) || "";
  return auth === `Bearer ${secret}` || key === secret;
}

// DEBUG/RE-TEST: analyze ONE thread on demand and return the composed nudge in
// the HTTP response. Bypasses the cycle-skip and per-run batch so you can test a
// single thread instantly after a code change. Never posts to the channel.
// Usage: /api/nudge?key=...&thread=1784213730.941059
async function debugOneThread({ token, apiKey, model, provider, channel, threadTs, res }) {
  const messages = await slackClient.getThreadReplies(token, channel, threadTs);
  if (!messages || !messages.length) {
    return res.status(404).json({ error: "thread not found or empty", threadTs });
  }
  const ids = [...new Set(messages.map((m) => m.user).filter(Boolean))];
  const nameMap = await slackClient.getUserNames(token, ids);
  const nameOf = (id) => nameMap[id];

  const analysis = await analyzeThread({ messages, nameOf, apiKey, model, provider });
  if (analysis.status === "closed") {
    return res.status(200).json({ threadTs, status: "closed", analysis });
  }

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
  const prev = await getNudgeState(channel, threadTs);
  const renudge = isRenudge(prev, messages);
  // Same "no message since last nudge" check the scanner uses (preview accuracy).
  // Exclude the bot's OWN nudge posts (match nudge text; keep intake headers).
  const OUR_NUDGE_RE = /(\*Action needed\*|Escalation summary|:lock: \*CRITICAL|:rotating_light: \*CRITICAL|to move this forward)/i;
  const INTAKE_HEADER_RE = /\b(raise a product issue|pod escalation time|issue bucket|customer request id|root request id)\b/i;
  const isBotNudge = (m) => m && m.text && !INTAKE_HEADER_RE.test(m.text) && OUR_NUDGE_RE.test(m.text);
  // Ground-truth trailing nudge count (same logic the scanner stops on).
  let trailingNudges = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = (messages[i] && messages[i].text || "").trim();
    if (!t) continue;
    if (isBotNudge(messages[i])) { trailingNudges++; continue; }
    break;
  }
  let actionOnly = false;
  if (prev && prev.lastNudgeTs) {
    actionOnly = !messages.some((m) => m.user && Number(m.ts) > Number(prev.lastNudgeTs) && !isBotNudge(m));
  }
  const { text } = composeNudge({ analysis, isRenudge: renudge, actionOnly, participants, messages, blockedIds });

  // Resolve @IDs to names so the preview is readable without opening Slack.
  // Fall back to the POC map for people who didn't post in the thread (so
  // cc'd leads like Kunal show a name, not a raw U-id — preview only).
  const pocNameById = {};
  for (const [k, id] of Object.entries(PEOPLE)) pocNameById[id] = k;
  const readable = text.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${nameMap[id] || pocNameById[id] || id}`);
  // Debug: expose the stored nudge state + streak math so we can see WHY the
  // 3-strike stop did or didn't fire for this thread.
  const _debug = {
    trailingNudges,
    wouldStop: trailingNudges >= Number(process.env.MAX_UNANSWERED_NUDGES || 3),
    storedState: prev || null,
    consecutiveNoReply_stored: prev ? (prev.consecutiveNoReply ?? null) : null,
    lastNudgeTs: prev ? (prev.lastNudgeTs || null) : null,
    lastMessageTs: messages.length ? messages[messages.length - 1].ts : null,
    humanSinceLastNudge: prev && prev.lastNudgeTs
      ? messages.some((m) => m.user && Number(m.ts) > Number(prev.lastNudgeTs) && !isBotNudge(m))
      : null,
  };
  return res.status(200).json({ threadTs, status: "open", isRenudge: renudge, analysis, nudgeText: text, preview: readable, _debug });
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const token = process.env.SLACK_BOT_TOKEN;
  const provider = (process.env.LLM_PROVIDER || "mistral").toLowerCase();
  const apiKey = provider === "mistral" ? process.env.MISTRAL_API_KEY : process.env.GROQ_API_KEY;
  const model = process.env.LLM_MODEL || (provider === "mistral" ? "mistral-medium-2508" : "llama-3.1-8b-instant");
  const channel = process.env.PRODUCT_CHANNEL_ID; // C07GZK9UKQW
  const mode = process.env.NUDGE_MODE || "draft";

  // Targeted single-thread re-test (never posts). Accepts the dotted thread_ts
  // (1784213730.941059) or the permalink digits (1784213730941059).
  const threadParam = (req.query && req.query.thread) || "";
  if (threadParam) {
    let threadTs = String(threadParam);
    if (!threadTs.includes(".") && threadTs.length > 6) {
      threadTs = threadTs.slice(0, threadTs.length - 6) + "." + threadTs.slice(-6);
    }
    try {
      return await debugOneThread({ token, apiKey, model, provider, channel, threadTs, res });
    } catch (e) {
      return res.status(500).json({ error: String(e && e.stack ? e.stack : e), threadTs });
    }
  }

  try {
    const results = await scanChannel({ token, apiKey, model, provider, channel });
    const openNudges = results.filter((r) => r.nudgeText);
    const st = results._stats || {};

    if (mode === "auto") {
      let posted = 0;
      for (const r of openNudges) {
        try {
          await slackClient.postThreadReply(token, channel, r.threadTs, r.nudgeText);
          await recordNudge(channel, r);
          posted++;
        } catch {}
      }
      return res.status(200).json({ mode, posted, stats: st });
    }

    // draft mode: DM Subhang this run's proposed nudges.
    const note = st.remaining > 0
      ? `_(${st.analyzed} analyzed this run · ${st.remaining} still queued — next scheduled run continues)_`
      : `_(sweep complete — all ${st.totalActive} active/tracked thread(s) covered)_`;
    const header = `:eyes: *Proposed escalation nudges* — ${openNudges.length} stuck (last ${process.env.LOOKBACK_DAYS || 3} days). ${note}\n`;
    const blocks = openNudges.map((r, i) => {
      const tag = r.isRenudge ? " *(RE-NUDGE — no reply since last nudge; Sita cc'd)*" : "";
      return `\n*${i + 1}.* <${r.permalink}|open thread>${tag}\n${r.nudgeText}`;
    });
    if (openNudges.length) {
      await slackClient.dmUser(token, PEOPLE.SUBHANG, header + blocks.join("\n"));
    }
    // Record nudge state in DRAFT mode too. Without this, lastNudgeTs / cooldown /
    // isRenudge / the 3-strike streak are never persisted, so the same thread gets
    // re-drafted every run and the stop/cooldown logic can never fire. Recording
    // here makes draft behave like auto (minus the actual channel post), so what
    // you review in draft matches what will post live.
    for (const r of openNudges) {
      try { await recordNudge(channel, r); } catch {}
    }
    return res.status(200).json({ mode, drafted: openNudges.length, stats: st });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
};
