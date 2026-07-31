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

    // 3. Replay the exact scanner fetch + filter to see where threads drop.
    const now = Date.now() / 1000;
    const activeSince = now - Number(process.env.LOOKBACK_DAYS || 5) * 86400;
    const parentLookbackDays = Number(process.env.PARENT_LOOKBACK_DAYS || 60);
    const parentOldest = (now - parentLookbackDays * 86400).toFixed(6);

    const bigRes = await fetch("https://slack.com/api/conversations.history", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel, oldest: parentOldest, limit: 200, inclusive: true }),
    });
    const bigJson = await bigRes.json();
    const all = bigJson.messages || [];
    const passType = all.filter((m) => m.type === "message");
    const passSubtype = passType.filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast");
    const passTs = passSubtype.filter((m) => m.ts && /^\d+\.\d+$/.test(m.ts));
    const passRecency = passTs.filter((m) => Number(m.latest_reply || m.ts) >= activeSince);

    // 4. Try fetching replies for each recency-passing candidate; report outcome.
    const threadProbe = [];
    for (const m of passRecency) {
      const threadTs = m.thread_ts || m.ts;
      try {
        const rr = await fetch("https://slack.com/api/conversations.replies", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ channel, ts: threadTs, limit: 200 }),
        });
        const rj = await rr.json();
        threadProbe.push({ threadTs, ok: rj.ok, error: rj.error || null, msgs: (rj.messages || []).length });
      } catch (e) {
        threadProbe.push({ threadTs, ok: false, error: String(e), msgs: 0 });
      }
    }

    return res.status(200).json({
      auth_ok: authJson.ok,
      granted_scopes: scopes,
      channel_probed: channel,
      history_ok: histJson.ok,
      history_error: histJson.error || null,
      messages_returned: (histJson.messages || []).length,
      sample,
      filter_replay: {
        now,
        activeSince,
        parentOldest,
        big_history_ok: bigJson.ok,
        big_history_error: bigJson.error || null,
        total_fetched: all.length,
        pass_type: passType.length,
        pass_subtype: passSubtype.length,
        pass_ts: passTs.length,
        pass_recency: passRecency.length,
      },
      thread_probe: threadProbe,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
