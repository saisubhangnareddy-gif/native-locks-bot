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
  // Token control: always keep the ROOT (escalation details) + the most recent
  // replies (where the current blocker lives). Old middle messages rarely change
  // the "where is it stuck now" verdict and just inflate tokens.
  const KEEP_RECENT = Number(process.env.KEEP_RECENT_MSGS || 30);
  let msgs = messages;
  let omittedNote = "";
  if (messages.length > KEEP_RECENT + 1) {
    const root = messages[0];
    const recent = messages.slice(-KEEP_RECENT);
    const omitted = messages.length - 1 - KEEP_RECENT;
    msgs = [root, ...recent];
    omittedNote = `\n… [${omitted} earlier reply(ies) omitted for brevity] …`;
  }
  const line = (m) => {
    const who = nameOf(m.user) || m.bot_id || "unknown";
    const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
    const text = (m.text || "").replace(/\s+/g, " ").trim().slice(0, 600);
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
- revisit was DONE and issue resolved (not just "revisit created/aligned")
- replacement was DELIVERED to customer and confirmed (not just "sheet filled" or "approved")
- spare part DELIVERED/installed and issue fixed
- a firm denial was given AND accepted, with no open customer demand

Otherwise it is OPEN. If OPEN, identify the single most accurate blocker state from this list:
${Object.entries(BLOCKERS).map(([k, v]) => `- ${k}: ${v.label}`).join("\n")}

Rules:
- "Replacement sheet filled row no X" => the replacement is INITIATED but NOT delivered. If nothing further, blocker is replacement_delivery_pending.
- "revisit created / aligned / will visit tomorrow" => revisit_eta_pending (assigned, awaiting completion). If a revisit is NEEDED but no PX aligned yet => revisit_not_aligned.
- Spare part (mortise, RF module, spring, strike plate) requested but not confirmed delivered => spare_not_sent.
- A fresh escalation with no substantive POC reply / no next step => awaiting_diagnosis.
- Judge the LATEST state: a question answered later, or a decision revised later, overrides earlier messages.

CRITICAL — rca_not_closed is ONLY for TECHNICAL / engineering root-cause investigations:
firmware bugs, battery drain/leakage, PCB/mother-PCB failure, camera/live-video, motion-sensor,
Wi-Fi/notification-signal debugging, "under RCA", "backend team investigating".
DO NOT use rca_not_closed for any of these — pick a different blocker instead:
- PX damaged the door / property damage / poor installation / unprofessional behaviour => install_quality
- Customer wants a supervisor/manager call, refund demand, dissatisfaction with service => awaiting_diagnosis (or social/legal if threatened)
- Strike-plate / mortise alignment, re-fitting, revisit-type fixes => revisit_not_aligned or revisit_eta_pending
- Delivery / tracking / pickup logistics => delivery_delay / replacement_delivery_pending / reverse_pickup_pending
If unsure and it is NOT a technical engineering investigation, do NOT default to rca_not_closed.

Also decide who the thread is currently WAITING ON (the person who owes the next action), by name if visible.

WRITE A SPECIFIC, EVIDENCE-BASED SUMMARY grounded in the WHOLE thread (read the root escalation AND every reply):
- "issue_reported": <=140 char — what the CUSTOMER originally reported (from the escalation/root message). The core problem.
- "steps_taken": <=300 char — a CHRONOLOGICAL synthesis of everything done/attempted across the thread, in order, reading EVERY reply. Include concrete actions and outcomes (e.g. "Diagnosed on call → auto-lock failing; PX revisit 30 Jul re-seated mortise but issue persisted; replacement approved, sheet row 1531 filled; spare dispatched, tracking 18127599232"). Name the actions and who did them where visible. Do NOT just restate the issue or paraphrase only the last message; cover the whole arc. If genuinely nothing was done, say "No substantive action taken yet."
- "current_status": <=140 char — where it stands RIGHT NOW and exactly what is missing/pending.
- "one_line": <=160 char — a single-line condensation of current_status (used in the digest).
- "ask": one situation-specific question to the blocked POC for the precise missing next step / ETA. Tailor to THIS thread, not a template.
- "last_activity": <=100 char paraphrase of the most recent substantive message + who sent it (digest only).

Return ONLY compact JSON:
{"status":"open|closed","blocker":"<key or null>","waiting_on":"<name or role or null>","issue_reported":"<...>","steps_taken":"<...>","current_status":"<...>","one_line":"<...>","ask":"<...>","last_activity":"<...>"}`;

async function analyzeThread({ messages, nameOf, groqKey, model }) {
  const transcript = renderTranscript(messages, nameOf);
  const critical = scanCritical(transcript);

  // Groq — OpenAI-compatible chat completions. Free tier: 30 RPM, 14,400 RPD.
  const modelId = model || "llama-3.1-8b-instant";
  const url = "https://api.groq.com/openai/v1/chat/completions";

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

  let json;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqKey}`,
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
  if (!json) throw new Error("Groq error: no response");
  if (json.error) throw new Error(`Groq error: ${json.error.message || JSON.stringify(json.error)}`);

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
      waiting_on: null,
      issue_reported: null,
      steps_taken: null,
      current_status: rawText ? rawText.slice(0, 140) : "Could not parse; review manually.",
      one_line: rawText ? rawText.slice(0, 130) : "Could not parse; review manually.",
      last_activity: null,
    };
  }

  // Critical override: if keywords fired, force-flag even if LLM said closed.
  if (critical.length) {
    parsed.critical = critical;
    if (parsed.status === "closed") parsed.status = "open";
  }
  return parsed;
}

module.exports = { analyzeThread, scanCritical, renderTranscript };
