// ============================================================================
// /api/nudge  — the per-thread nudger.
//
// Modes (env NUDGE_MODE):
//   "draft" (default) -> scans, then DMs Subhang ONE message listing every
//                        proposed nudge for approval. Posts nothing in-channel.
//   "auto"            -> posts each nudge as a threaded reply in the channel
//                        and records re-nudge state.
//
// Secured by a shared secret: caller must send  ?key=CRON_SECRET  (Vercel Cron
// sends the Authorization: Bearer <CRON_SECRET> header automatically).
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
  const geminiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const channel = process.env.PRODUCT_CHANNEL_ID; // C07GZK9UKQW
  const mode = process.env.NUDGE_MODE || "draft";

  try {
    const results = await scanChannel({ token, geminiKey, model, channel });
    const openNudges = results.filter((r) => r.nudgeText);

    if (mode === "auto") {
      const posted = [];
      for (const r of openNudges) {
        await slackClient.postThreadReply(token, channel, r.threadTs, r.nudgeText);
        await recordNudge(channel, r);
        posted.push(r.permalink);
      }
      return res.status(200).json({ mode, posted: posted.length, results: posted });
    }

    // draft mode: DM Subhang a single digest of proposed nudges for approval.
    const header = `:eyes: *Proposed escalation nudges* — ${openNudges.length} thread(s) look stuck (last ${process.env.LOOKBACK_DAYS || 5} days).\nReply-review before I post. Approve by switching NUDGE_MODE=auto, or nudge manually.\n`;
    const blocks = openNudges.map((r, i) => {
      const tag = r.isRenudge ? " *(RE-NUDGE — no reply since last time; Sita cc'd)*" : "";
      return `\n*${i + 1}.* <${r.permalink}|open thread>${tag}\n_Draft:_\n${r.nudgeText}`;
    });
    const body = openNudges.length ? header + blocks.join("\n") : ":white_check_mark: No stuck threads found in the window.";

    await slackClient.dmUser(token, PEOPLE.SUBHANG, body);
    return res.status(200).json({ mode, drafted: openNudges.length, stats: results._stats });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
};
