// /api/debug — TEMPORARY diagnostic. Shows which scopes the live SLACK_BOT_TOKEN
// actually carries + the bot's own identity. Delete after debugging.
// Call: /api/debug?key=CRON_SECRET

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const key = (req.query && req.query.key) || "";
  const auth = req.headers["authorization"] || "";
  if (secret && auth !== `Bearer ${secret}` && key !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.PRODUCT_CHANNEL_ID;
  try {
    // 1. Identity + scopes
    const authRes = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const scopes = authRes.headers.get("x-oauth-scopes");
    const authJson = await authRes.json();

    // 2. Raw conversations.history probe (small sample, no oldest filter)
    const histRes = await fetch("https://slack.com/api/conversations.history", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, limit: 5 }),
    });
    const histJson = await histRes.json();

    const sample = (histJson.messages || []).slice(0, 5).map((m) => ({
      type: m.type,
      subtype: m.subtype || null,
      ts: m.ts,
      thread_ts: m.thread_ts || null,
      reply_count: m.reply_count || 0,
      latest_reply: m.latest_reply || null,
      text_snippet: (m.text || "").slice(0, 40),
    }));

    return res.status(200).json({
      auth_ok: authJson.ok,
      bot_user_id: authJson.user_id,
      granted_scopes: scopes,
      channel_probed: channel,
      history_ok: histJson.ok,
      history_error: histJson.error || null,
      messages_returned: (histJson.messages || []).length,
      sample,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
