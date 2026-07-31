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
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // auth.test returns the granted scopes in a response header.
    const scopes = r.headers.get("x-oauth-scopes");
    const json = await r.json();
    return res.status(200).json({
      ok: json.ok,
      bot_user_id: json.user_id,
      bot_name: json.user,
      team: json.team,
      token_prefix: token ? token.slice(0, 12) + "…" : "MISSING",
      granted_scopes: scopes,
      slack_error: json.error || null,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
