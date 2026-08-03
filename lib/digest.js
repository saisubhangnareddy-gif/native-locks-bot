// Builds the morning digest posted to #pending-escalations-summariser.
// Input: open-escalation records accumulated in KV by the nudger, each shaped
// { threadTs, permalink, blocker, critical, one_line, pocs }.
// Categorizes: Critical first, then product issues grouped by blocker.

const { BLOCKERS, CRITICAL_SIGNALS } = require("./poc-map");
const { tagAll } = require("./nudge");

function buildDigest(records, { channelName }) {
  const open = Array.isArray(records) ? records : [];
  const critical = open.filter((r) => r.critical && r.critical.length);
  const normal = open.filter((r) => !(r.critical && r.critical.length));

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

  const lines = [];
  lines.push(`:memo: *Pending Escalations Summary — ${today}*`);
  lines.push(`Source: #${channelName} · window: last ${process.env.LOOKBACK_DAYS || 3} days · ${open.length} open`);
  lines.push("");

  // --- Critical ---
  lines.push(`:rotating_light: *CRITICAL — ${critical.length}*`);
  if (!critical.length) lines.push("_None pending. :white_check_mark:_");
  critical.forEach((r) => {
    const key = r.critical[0];
    const label = (CRITICAL_SIGNALS[key] && CRITICAL_SIGNALS[key].label) || key;
    lines.push(`• *${label}* — ${r.one_line || ""}`);
    lines.push(`   blocked on ${tagAll(r.pocs || [])} · <${r.permalink}|open thread>`);
  });
  lines.push("");

  // --- Product issues grouped by blocker ---
  lines.push(`:wrench: *PRODUCT ISSUES PENDING — ${normal.length}*`);
  const byBlocker = {};
  normal.forEach((r) => {
    const b = r.blocker || "awaiting_diagnosis";
    (byBlocker[b] = byBlocker[b] || []).push(r);
  });
  const order = Object.keys(BLOCKERS);
  for (const b of order) {
    const group = byBlocker[b];
    if (!group || !group.length) continue;
    lines.push(`\n*${BLOCKERS[b].label}* (${group.length})`);
    group.forEach((r) => {
      lines.push(`• ${r.one_line || "(no summary)"} — blocked on ${tagAll(r.pocs || [])} · <${r.permalink}|thread>`);
    });
  }
  // Any blocker keys not in the canonical order (safety).
  for (const b of Object.keys(byBlocker)) {
    if (order.includes(b)) continue;
    const group = byBlocker[b];
    lines.push(`\n*${b}* (${group.length})`);
    group.forEach((r) => {
      lines.push(`• ${r.one_line || "(no summary)"} — blocked on ${tagAll(r.pocs || [])} · <${r.permalink}|thread>`);
    });
  }

  return lines.join("\n");
}

module.exports = { buildDigest };
