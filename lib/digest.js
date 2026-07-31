// Builds the daily morning digest posted to #pending-escalations-summariser.
// Categorizes open escalations: Critical first, then product issues by blocker.

const { BLOCKERS, CRITICAL_SIGNALS } = require("./poc-map");
const { tagAll } = require("./nudge");

function buildDigest(results, { channelName }) {
  const open = results.filter((r) => r.analysis && r.analysis.status === "open");
  const critical = open.filter((r) => r.analysis.critical && r.analysis.critical.length);
  const normal = open.filter((r) => !(r.analysis.critical && r.analysis.critical.length));

  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

  let lines = [];
  lines.push(`:memo: *Pending Escalations Summary — ${today}*`);
  lines.push(`Source: #${channelName} · window: last ${process.env.LOOKBACK_DAYS || 5} days · ${open.length} open`);
  lines.push("");

  // --- Critical ---
  lines.push(`:rotating_light: *CRITICAL — ${critical.length}*`);
  if (!critical.length) lines.push("_None pending. :white_check_mark:_");
  critical.forEach((r) => {
    const key = r.analysis.critical[0];
    const label = CRITICAL_SIGNALS[key].label;
    lines.push(`• *${label}* — ${r.analysis.one_line || ""}`);
    lines.push(`   blocked on ${tagAll(r.pocs)} · <${r.permalink}|open thread>`);
  });
  lines.push("");

  // --- Product issues grouped by blocker ---
  lines.push(`:wrench: *PRODUCT ISSUES PENDING — ${normal.length}*`);
  const byBlocker = {};
  normal.forEach((r) => {
    const b = r.analysis.blocker || "awaiting_diagnosis";
    (byBlocker[b] = byBlocker[b] || []).push(r);
  });
  const order = Object.keys(BLOCKERS);
  for (const b of order) {
    const group = byBlocker[b];
    if (!group || !group.length) continue;
    lines.push(`\n*${BLOCKERS[b].label}* (${group.length})`);
    group.forEach((r) => {
      lines.push(`• ${r.analysis.one_line || "(no summary)"} — blocked on ${tagAll(r.pocs)} · <${r.permalink}|thread>`);
    });
  }

  return lines.join("\n");
}

module.exports = { buildDigest };
