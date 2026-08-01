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

WRITE A SPECIFIC, EVIDENCE-BASED STATUS. Do not be generic. Ground it in the ACTUAL latest messages:
- "one_line": a concrete <=160 char summary of what the issue is and exactly where it is stuck RIGHT NOW, referencing the real situation (e.g. "Replacement approved 30 Jul, sheet row 1531 filled, but no tracking ID shared yet" or "Mortise replacement requested; awaiting spare dispatch confirmation from Manuranjan"). Use specifics from the thread — issue type, what was done, what is missing.
- "ask": a one-sentence, situation-specific question to the blocked POC asking for the precise missing next step / ETA (e.g. "could you share the courier tracking ID and EDD for the replacement on row 1531?"). Tailor it to THIS thread, not a template.
- "last_activity": <=100 char paraphrase of the single most recent substantive message and who sent it.

Return ONLY compact JSON:
{"status":"open|closed","blocker":"<key or null>","waiting_on":"<name or role or null>","one_line":"<specific status>","ask":"<specific question to POC>","last_activity":"<recent msg paraphrase>"}`;

async function analyzeThread({ messages, nameOf, groqKey, model }) {
  const transcript = renderTranscript(messages, nameOf);
  const critical = scanCritical(transcript);

  // Groq — OpenAI-compatible chat completions. Free tier: 30 RPM, 14,400 RPD.
  const modelId = model || "llama-3.3-70b-versatile";
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const body = {
    model: modelId,
    temperature: 0,
    max_tokens: 400,
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
