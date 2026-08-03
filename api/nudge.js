// ============================================================================
// /api/nudge  — the per-thread nudger (chunked + self-chaining).
//
// Each invocation analyzes a bounded BATCH of active threads that weren't yet
// analyzed this cycle, then — if threads remain — triggers the next batch
// (fire-and-forget) so a full sweep of all active threads completes across a
// few chained invocations without exceeding the serverless time limit.
//
// Modes (env NUDGE_MODE): "draft" (DM Subhang) | "auto" (post in-channel).
// Secured by CRON_SECRET (?key= or Bearer header).
// ============================================================================

const { scanChannel, recordNudge } = require("../lib/scanner");
const slackClient = require("../lib/slack");
const { PEOPLE } = require("../lib/poc-map");

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers["authorization"] || "";
  const key = (req.query && req.query.key) || "";
  return auth === `Bearer ${secret}` || key === secret;
}

// Fire the next run to continue the sweep if threads remain. Best-effort:
// we await the kickoff briefly; if it doesn't land, the scheduled crons and
// manual re-runs still drain the remaining pending threads (nothing is lost —
// pending threads persist in KV until analyzed).
async function chainNextBatch(req) {
  try {
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const host = req.headers["host"];
    const secret = process.env.CRON_SECRET || "";
    const url = `${proto}://${host}/api/nudge?key=${encodeURIComponent(secret)}&chained=1`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try { await fetch(url, { method: "GET", signal: ctrl.signal }); }
    catch {} finally { clearTimeout(t); }
  } catch {}
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const token = process.env.SLACK_BOT_TOKEN;
  const groqKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const channel = process.env.PRODUCT_CHANNEL_ID; // C07GZK9UKQW
  const mode = process.env.NUDGE_MODE || "draft";
  const isChained = req.query && req.query.chained === "1";

  try {
    const results = await scanChannel({ token, groqKey, model, channel });
    const openNudges = results.filter((r) => r.nudgeText);
    const st = results._stats || {};

    // If more active threads remain in this cycle, kick off the next batch now.
    if (st.remaining > 0) await chainNextBatch(req);

    if (mode === "auto") {
      const posted = [];
      for (const r of openNudges) {
        await slackClient.postThreadReply(token, channel, r.threadTs, r.nudgeText);
        await recordNudge(channel, r);
        posted.push(r.permalink);
      }
      return res.status(200).json({ mode, posted: posted.length, results: posted, stats: st });
    }

    // draft mode: DM Subhang this batch's proposed nudges.
    const batchNote = st.remaining > 0
      ? `_(batch of ${st.batchFetched}; ${st.remaining} more active thread(s) queued — next batch running now)_`
      : `_(final batch — all ${st.totalActive} active thread(s) covered this cycle)_`;
    const header = `:eyes: *Proposed escalation nudges* — ${openNudges.length} stuck in this batch (last ${process.env.LOOKBACK_DAYS || 3} days). ${batchNote}\n`;
    const blocks = openNudges.map((r, i) => {
      const tag = r.isRenudge ? " *(RE-NUDGE — no reply since last time; Sita cc'd)*" : "";
      return `\n*${i + 1}.* <${r.permalink}|open thread>${tag}\n_Draft:_\n${r.nudgeText}`;
    });
    // Only DM if there's something to show OR it's the final batch (so you get a
    // clear "cycle complete" signal even when the last batch had no stuck items).
    if (openNudges.length || st.remaining === 0) {
      const body = openNudges.length
        ? header + blocks.join("\n")
        : `:white_check_mark: Batch complete — no stuck threads in this batch. ${batchNote}`;
      await slackClient.dmUser(token, PEOPLE.SUBHANG, body);
    }
    return res.status(200).json({ mode, drafted: openNudges.length, chained: isChained, stats: st });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
};
