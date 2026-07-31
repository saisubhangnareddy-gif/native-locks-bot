// ============================================================================
// /api/digest — the 10am daily summary.
//
// Scans the product channel, builds a categorized digest (Critical first,
// then product issues by blocker with POCs + thread links), and:
//   mode "draft" -> DMs the digest to Subhang for review.
//   mode "auto"  -> posts to #pending-escalations-summariser (C0BM587169G).
// ============================================================================

const { scanChannel } = require("../lib/scanner");
const { buildDigest } = require("../lib/digest");
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
  const channel = process.env.PRODUCT_CHANNEL_ID;      // C07GZK9UKQW
  const digestChannel = process.env.DIGEST_CHANNEL_ID;  // C0BM587169G
  const mode = process.env.DIGEST_MODE || "draft";

  try {
    const results = await scanChannel({ token, geminiKey, model, channel });
    const text = buildDigest(results, { channelName: "native-lock-product-issues" });

    if (mode === "auto") {
      await slackClient.postMessage(token, digestChannel, text);
      return res.status(200).json({ mode, posted: true, open: results.filter((r) => r.nudgeText).length });
    }
    await slackClient.dmUser(token, PEOPLE.SUBHANG, `:memo: *Draft digest* (would post to #pending-escalations-summariser):\n\n${text}`);
    return res.status(200).json({ mode, drafted: true });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
};
