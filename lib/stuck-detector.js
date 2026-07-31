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
  return messages
    .map((m) => {
      const who = nameOf(m.user) || m.bot_id || "unknown";
      const when = new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
      const text = (m.text || "").replace(/\s+/g, " ").trim();
      const files = (m.files || []).length ? ` [${m.files.length} attachment(s)]` : "";
      return `[${when}] ${who}: ${text}${files}`;
    })
    .join("\n");
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
- Battery drain / PCB / camera-firmware "under RCA" / "backend team working" / "wait a week" => rca_not_closed.
- Spare part (mortise, RF module, spring, strike plate) requested but not confirmed delivered => spare_not_sent.
- A fresh escalation with no substantive POC reply / no next step => awaiting_diagnosis.
- Judge the LATEST state: a question answered later, or a decision revised later, overrides earlier messages.

Also decide who the thread is currently WAITING ON (the person who owes the next action), by name if visible.

Return ONLY compact JSON:
{"status":"open|closed","blocker":"<key or null>","waiting_on":"<name or role or null>","one_line":"<=140 char status summary","last_activity_actor":"<name or null>"}`;

async function analyzeThread({ messages, nameOf, geminiKey, model }) {
  const transcript = renderTranscript(messages, nameOf);
  const critical = scanCritical(transcript);

  const modelId = model || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${geminiKey}`;

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      { role: "user", parts: [{ text: `THREAD TRANSCRIPT:\n${transcript}\n\nReturn the JSON now.` }] },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 400,
      responseMimeType: "application/json",
    },
  };

  let json;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 503) {
      // Rate limited / overloaded — exponential backoff then retry.
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
      continue;
    }
    json = await res.json();
    break;
  }
  if (!json) throw new Error("Gemini error: rate_limited after retries");
  if (json.error) throw new Error(`Gemini error: ${json.error.message}`);

  let parsed;
  try {
    const raw = json.candidates[0].content.parts[0].text.trim().replace(/^```json\s*|\s*```$/g, "");
    parsed = JSON.parse(raw);
  } catch {
    parsed = { status: "open", blocker: "awaiting_diagnosis", waiting_on: null, one_line: "Could not parse; review manually.", last_activity_actor: null };
  }

  // Critical override: if keywords fired, force-flag even if LLM said closed.
  if (critical.length) {
    parsed.critical = critical;
    if (parsed.status === "closed") parsed.status = "open";
  }
  return parsed;
}

module.exports = { analyzeThread, scanCritical, renderTranscript };
