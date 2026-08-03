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
const { PEOPLE } = require("../lib/poc-map");

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers["authorization"] || "";
  const key = (req.query && req.query.key) || "";
  return auth === `Bearer ${secret}` || key === secret;
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const token = process.env.SLACK_BOT_TOKEN;
  const provider = (process.env.LLM_PROVIDER || "mistral").toLowerCase();
  const apiKey = provider === "mistral" ? process.env.MISTRAL_API_KEY : process.env.GROQ_API_KEY;
  const model = process.env.LLM_MODEL || (provider === "mistral" ? "mistral-medium-2508" : "llama-3.1-8b-instant");
  const channel = process.env.PRODUCT_CHANNEL_ID; // C07GZK9UKQW
  const mode = process.env.NUDGE_MODE || "draft";

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
    return res.status(200).json({ mode, drafted: openNudges.length, stats: st });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
};
