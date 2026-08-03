// ============================================================================
// STUCK DETECTOR — the brain of the bot.
//
// For each thread it takes the FULL context (escalation root message + every
// reply, in order) and asks an LLM to decide, purely from thread text:
//   - is this escalation CLOSED (resolved / revisit done / replacement
//     delivered / spare delivered / customer confirmed OK)?  -> skip
//   - if OPEN, what is it stuck ON, and who is it blocked on?
//
// No sheets, no external state — thread text is the only source of truth
// (per your instruction).
// ============================================================================

const { BLOCKERS, CRITICAL_SIGNALS, PEOPLE } = require("./poc-map");

// Deterministic critical pre-scan on raw thread text (cheap safety net so we
// never miss a lockout / legal threat even if the LLM is unsure).
function scanCritical(threadText) {
  const t = threadText.toLowerCase();
  const hits = [];
  for (const [key, def] of Object.entries(CRITICAL_SIGNALS)) {
    if (def.keywords.some((k) => t.includes(k))) hits.push(key);
  }
  return hits;
}

// Build the compact transcript we hand to the LLM.
function renderTranscript(messages, nameOf) {
  // Send the FULL thread by default so no message (e.g. a mid-thread "resolved"
  // or the actual fix) is ever hidden. Only trim if a thread is extremely long,
  // and when we do, keep the root + the most recent messages and flag the gap.
  const KEEP_RECENT = Number(process.env.KEEP_RECENT_MSGS || 120);
  let msgs = messages;
  let omittedNote = "";
  if (messages.length > KEEP_RECENT + 1) {
    const root = messages[0];
    const recent = messages.slice(-KEEP_RECENT);
    const omitted = messages.length - 1 - KEEP_RECENT;
    msgs = [root, ...recent];
    omittedNote = `\n… [${omitted} earlier reply(ies) omitted — very long thread] …`;
  }
  const line = (m) => {
    const who = nameOf(m.user) || m.bot_id || "unknown";
    const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
    const text = (m.text || "").replace(/\s+/g, " ").trim().slice(0, 800);
    const files = (m.files || []).length ? ` [${m.files.length} attachment(s)]` : "";
    return `[${when}] ${who}: ${text}${files}`;
  };
  if (!omittedNote) return msgs.map(line).join("\n");
  return [line(msgs[0]) + omittedNote, ...msgs.slice(1).map(line)].join("\n");
}

const SYSTEM_PROMPT = `You are an operations analyst for Urban Company's Native Smart Locks escalation channel.
You read a single Slack escalation thread (a customer issue) and decide its status STRICTLY from the thread text.

An escalation is CLOSED only if the thread clearly shows one of:
- customer confirmed the issue is resolved / working now / "case closed"
- an agent/SME/PX states the issue was fixed/resolved (e.g. "issue has now been resolved", "fixed by ...", "working fine now") — even if that message is in the MIDDLE of the thread, not the last one
- revisit was DONE and issue resolved (not just "revisit created/aligned")
- replacement was DELIVERED to customer and confirmed (not just "sheet filled" or "approved")
- spare part DELIVERED/installed and issue fixed
- a firm denial was given AND accepted, with no open customer demand
READ EVERY MESSAGE for a resolution statement — a "resolved"/"fixed" note anywhere in the thread means CLOSED unless a LATER message reopens it.

Otherwise it is OPEN. If OPEN, identify the single most accurate blocker state from this list:
${Object.entries(BLOCKERS).map(([k, v]) => `- ${k}: ${v.label}`).join("\n")}

ROUTING RULES — pick the blocker that matches the CURRENT stuck state:
- Fresh escalation, no substantive POC reply / next step => awaiting_diagnosis.
- Issue needs validation / root-cause by the SKU POC (is it real? revisit or replacement?) => rca_not_closed.
- ONLY when primary POCs explicitly could not close it and it needs deep firmware/software/electronics investigation by Engineering (PCB, firmware bug, signal logic) => deep_firmware_rca. Do NOT use this for hardware/mechanical or discovery like "check debugger if it's RF module or lock bell" — that stays rca_not_closed with the SKU POC.
- Customer's config / setup / master-PIN / mPIN stuck needing an entity reset => entity_reset.
- "Replacement sheet filled row no X" but not delivered => replacement_delivery_pending.
- Replacement needed but not yet initiated / no sheet => replacement_not_assigned.
- Spare part (mortise, RF module, spring, strike plate, battery box) requested but not confirmed dispatched => spare_not_sent.
- Revisit NEEDED but no PX aligned => revisit_not_aligned. Revisit created/aligned but not done => revisit_eta_pending.
- A PX-led error, poor installation, property damage, OR a revisit audit / work-quality check => revisit_audit_quality.
- Defective unit reverse pickup pending => reverse_pickup_pending.
- Delivery delayed / SLA breach / no tracking => delivery_delay.
- Judge the LATEST state: a later message overrides earlier ones.

Also extract:
- "sku": the lock SKU if visible in the thread (e.g. "Native Lock Ultra", "Native Lock Pro", "Native Lock S"); else null. This decides RCA routing.
- "pickup_dest": if the thread mentions the defective unit must go to "proms" => "proms"; else "warehouse". Only relevant for reverse_pickup_pending.
- "active_sme": if a specific SME / trainer clearly worked this case (diagnosed, visited, or fixed it) — e.g. "Manohar fixed it", "Chandan visited" — return their first name only (e.g. "Manohar"). Only meaningful for revisit-audit / PX-quality cases where ONE named person is the actor. If no single SME is clearly the actor, null.

Decide who the thread is currently WAITING ON (the person who owes the next action), by name if visible.

WRITE A SPECIFIC, EVIDENCE-BASED SUMMARY grounded in the WHOLE thread (read the root escalation AND every reply):
- "issue_reported": <=140 char — what the CUSTOMER originally reported (from the escalation/root message). The core problem. Do NOT copy relative-time words like "today"/"yesterday" verbatim from old messages (they mislead the reader about when it happened); rephrase neutrally (e.g. "back panel loose since installation") or use the actual date if visible.
- "steps_taken": <=300 char — a CHRONOLOGICAL synthesis of everything done/attempted across the thread, in order, reading EVERY reply. Include concrete actions and outcomes (e.g. "Diagnosed on call → auto-lock failing; PX revisit 30 Jul re-seated mortise but issue persisted; replacement approved, sheet row 1531 filled; spare dispatched, tracking 18127599232"). Name the actions and who did them where visible. Do NOT just restate the issue or paraphrase only the last message; cover the whole arc. If genuinely nothing was done, say "No substantive action taken yet."
- "current_status": <=140 char — where it stands RIGHT NOW and exactly what is missing/pending.
- "one_line": <=160 char — a single-line condensation of current_status (used in the digest).
- "ask": one situation-specific question for the blocked POC — the precise missing next step / ETA. Phrase it as a direct question WITHOUT addressing anyone by name (do NOT start with "Manuranjan," or "Jyothi," etc.); the system prepends the correct @mentions. Do NOT include raw Slack user IDs or <@...> mentions in any field.
- "last_activity": <=100 char paraphrase of the most recent substantive message + who sent it (digest only).

Return ONLY compact JSON:
{"status":"open|closed","blocker":"<key or null>","sku":"<sku or null>","pickup_dest":"proms|warehouse|null","active_sme":"<sme first name or null>","waiting_on":"<name or role or null>","issue_reported":"<...>","steps_taken":"<...>","current_status":"<...>","one_line":"<...>","ask":"<...>","last_activity":"<...>"}`;

async function analyzeThread({ messages, nameOf, apiKey, model, provider }) {
  const transcript = renderTranscript(messages, nameOf);
  const critical = scanCritical(transcript);

  // Provider-switchable, both OpenAI-compatible. Default: Mistral.
  //   mistral -> mistral-medium-latest (free tier: no monthly cap, strong quality)
  //   groq    -> llama-3.1-8b-instant  (fallback)
  const prov = (provider || process.env.LLM_PROVIDER || "mistral").toLowerCase();
  const isMistral = prov === "mistral";
  const url = isMistral
    ? "https://api.mistral.ai/v1/chat/completions"
    : "https://api.groq.com/openai/v1/chat/completions";
  const modelId = model || (isMistral ? "mistral-medium-2508" : "llama-3.1-8b-instant");

  const body = {
    model: modelId,
    temperature: 0,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `THREAD TRANSCRIPT:\n${transcript}\n\nReturn the JSON now.` },
    ],
  };

  const provLabel = isMistral ? "Mistral" : "Groq";
  let json;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      if (attempt === 2) { json = await res.json(); break; } // give up -> surface error
      const retryAfter = Number(res.headers.get("retry-after")) || (2 * (attempt + 1));
      await new Promise((r) => setTimeout(r, Math.min(retryAfter * 1000, 15000)));
      continue;
    }
    json = await res.json();
    break;
  }
  if (!json) throw new Error(`${provLabel} error: no response`);
  if (json.error) throw new Error(`${provLabel} error: ${json.error.message || JSON.stringify(json.error)}`);

  let parsed;
  let rawText = "";
  try {
    rawText = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || "").trim();
    let cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1) cleaned = cleaned.slice(first, last + 1);
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {
      status: "open",
      blocker: "awaiting_diagnosis",
      sku: null,
      pickup_dest: null,
      waiting_on: null,
      issue_reported: null,
      steps_taken: null,
      current_status: rawText ? rawText.slice(0, 140) : "Could not parse; review manually.",
      one_line: rawText ? rawText.slice(0, 130) : "Could not parse; review manually.",
      last_activity: null,
    };
  }

  // Strip raw Slack user IDs (e.g. "U0B99EPHE5P") the model sometimes copies
  // from the transcript into free-text fields — they render as ugly plain text.
  // The real POC mentions are added separately by the nudge composer.
  const stripIds = (s) => typeof s === "string"
    ? s.replace(/<@([A-Z0-9]+)>/g, "").replace(/\bU[A-Z0-9]{6,}\b[ ,:]*/g, "").replace(/\s{2,}/g, " ").trim()
    : s;
  for (const f of ["issue_reported", "steps_taken", "current_status", "one_line", "ask", "last_activity"]) {
    parsed[f] = stripIds(parsed[f]);
  }

  // Critical override: if keywords fired, force-flag even if LLM said closed.
  if (critical.length) {
    parsed.critical = critical;
    if (parsed.status === "closed") parsed.status = "open";
  }
  return parsed;
}

module.exports = { analyzeThread, scanCritical, renderTranscript };
