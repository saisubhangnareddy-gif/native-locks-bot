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

// Soft severity flag: the thread explicitly calls itself a "critical case" or a
// VSAT case (an ops-severity marker), WITHOUT a true lockout/legal trigger.
// We surface this as a visible note but do NOT fire the red banner or add the
// critical POCs/cc (per instruction: flag it, don't escalate).
function scanSoftFlag(threadText) {
  const t = threadText.toLowerCase();
  if (t.includes("critical case")) return "marked critical in-thread";
  if (/\bvsat\b/.test(t)) return "VSAT case flagged in-thread";
  return null;
}

// Deterministic withdrawal detector: a message clearly retracting the
// escalation ("please ignore", "pls ignore this", "raised by mistake",
// "duplicate ticket", "ignore this ticket/case/escalation"). Conservative
// phrasing to avoid false positives like "ignore the notification". Checked
// against the LAST message only — a withdrawal is the current state, and this
// avoids closing a thread that was later reopened.
const WITHDRAWN_RE = /\b(please ignore|pls ignore|ignore this (ticket|case|escalation|request)|raised by mistake|duplicate (ticket|case|escalation)|please close this|kindly ignore)\b/i;
function isWithdrawn(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  const last = messages[messages.length - 1];
  const lastText = (last && last.text) || "";
  // Also allow the second-to-last, since a bot/system row can trail a real msg.
  const prev = messages.length >= 2 ? (messages[messages.length - 2].text || "") : "";
  return WITHDRAWN_RE.test(lastText) || WITHDRAWN_RE.test(prev);
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
- someone confirms resolution in response to a "is this resolved?" style check — e.g. "yes", "yes resolved", "confirmed, working now", "cx confirmed it's fine"
- the escalation was WITHDRAWN / retracted / marked ignore or duplicate — e.g. someone (especially the raiser) says "please ignore", "ignore this", "pls close", "duplicate ticket", "raised by mistake", "not needed". Treat these as CLOSED and stop nudging.
READ EVERY MESSAGE for a resolution statement — a "resolved"/"fixed" note anywhere in the thread means CLOSED unless a LATER message reopens it.

Otherwise it is OPEN. If OPEN, identify the single most accurate blocker state from this list:
${Object.entries(BLOCKERS).map(([k, v]) => `- ${k}: ${v.label}`).join("\n")}

ROUTING RULES — pick the blocker that matches the CURRENT stuck state:
- Fresh escalation, no substantive POC reply / next step => awaiting_diagnosis.
- Issue needs validation / root-cause by the SKU POC (is it real? revisit or replacement?) => rca_not_closed.
- DO NOT PRESCRIBE AN UNVALIDATED RESOLUTION. Only classify as a revisit/replacement/spare blocker if a POC in the thread has ACTUALLY decided that action is needed (e.g. "please create revisit", "please replace the lock", "fill spare sheet"). A CUSTOMER asking for a PX visit/replacement, an agent relaying "cx wants a visit", or your own inference is NOT validation — never invent a revisit/replacement/spare that no POC committed to. If the thread is still waiting on the SKU POC's verdict/update (people are asking "@POC any update?", "please check", "please help here" and the POC hasn't decided the next step), the blocker is rca_not_closed (or awaiting_diagnosis) and the ask is for the POC's UPDATE/verdict — NOT "align a revisit" or "replace the lock". Judge only by what POCs have confirmed, not what the customer requested.
- ONLY when primary POCs explicitly could not close it and it needs deep firmware/software/electronics/LOGS investigation by Engineering (PCB, firmware bug, signal logic, offline-logs analysis) => deep_firmware_rca, tagged to Abhiram (alfadelta10010). Signals: someone explicitly asks "@alfadelta10010 / @Abhiram please check the logs / look into it / need your help to check", or the case has clearly moved past routine steps into a logs/firmware investigation. Do NOT use this for hardware/mechanical or discovery like "check debugger if it's RF module or lock bell" — that stays rca_not_closed with the SKU POC.
- ENTITY RESET vs LOGS RCA — do not confuse Gagan and Abhiram. Gagan does entity/config resets (mPIN, "entity stuck at registration"). If Gagan ALREADY did the reset and the case has since evolved into a WiFi-offline / logs / firmware investigation now handed to Abhiram, the CURRENT blocker is deep_firmware_rca (Abhiram) — NOT entity_reset (Gagan). Use the CURRENT tail state: whoever Engineering-side was LAST asked to investigate is the actor. Do not resurface Gagan's already-completed reset.
- Customer's config / setup / master-PIN / mPIN stuck needing an entity reset (and NOT yet done) => entity_reset (Gagan).
- "Replacement sheet filled row no X" but the parcel is still in transit / awaiting courier dispatch / tracking => replacement_delivery_pending.
- Replacement needed but not yet initiated / no sheet => replacement_not_assigned.
- ROHIT / DELIVERY IS NARROW: only route to delivery_delay or replacement_delivery_pending (Rohit Singh Bisht) when the thread EXPLICITLY shows a physical parcel ALREADY DISPATCHED and in transit with a courier tracking ID, and delivery is the stuck step. The following are NOT delivery cases and must NOT go to Rohit: "replacement approved", "sheet filled row X", "please share TAT/invoice/details", "share TAT with cx", pending on-site installation, or any step where an AGENT was asked to share/confirm something. Those are pre-dispatch handoffs — route by the actual pending step (usually the agent handoff, or replacement_not_assigned / revisit_not_aligned). If in doubt, do NOT pick Rohit.
- Spare part (mortise, RF module, spring, strike plate, battery box) requested but not confirmed dispatched => spare_not_sent.
- INSTALLATION vs DELIVERY — do NOT confuse them. If the replacement lock has ARRIVED/been approved and the stuck step is INSTALLING it at the customer (phrases like "lock not installed yet", "new lock installation pending", "install visit pending", "schedule installation", "align PX for installation") => this is a REVISIT alignment problem: revisit_not_aligned (no PX aligned) or revisit_eta_pending (visit booked but not done). It is NOT replacement_delivery_pending and NOT a delivery/logistics (Rohit) case. delivery_delay / replacement_delivery_pending / Rohit are ONLY for a physical parcel in transit with courier tracking, never for a pending on-site installation.
- Revisit NEEDED but no PX aligned => revisit_not_aligned. Revisit created/aligned but not done => revisit_eta_pending.
- A PX-led error, poor installation, property damage, OR a revisit audit / work-quality check => revisit_audit_quality.
- Defective unit reverse pickup pending => reverse_pickup_pending. (If BOTH install and old-unit pickup are pending, pick the step blocking progress first — usually the installation.)
- Delivery delayed / SLA breach / no tracking (a parcel in transit) => delivery_delay.
- Judge the LATEST state: a later message overrides earlier ones.

Also extract:
- "sku": the lock SKU if visible in the thread (e.g. "Native Lock Ultra", "Native Lock Pro", "Native Lock S"); else null. This decides RCA routing.
- "pickup_dest": the FINAL destination of the defective unit's reverse pickup. DEFAULT is "warehouse" (handled by Sharvan Negi). It is "proms" whenever the lock is ultimately going to the Proms office for physical RCA. Decide by these signals, in order: (1) if ANY message says the lock should go to Proms / "get this to proms" / "align it from Wh to Proms" / Padmanabhan is told to get/align it to Proms => "proms"; (2) else if the pickup is assigned only to Sharvan Negi (warehouse) with no Proms mention => "warehouse"; (3) if it literally says "proms" => "proms"; (4) otherwise => "warehouse". TWO-HOP RULE: the FINAL destination wins. If Sharvan is asked to pick from the customer BUT a message also says it's going "Wh to Proms" or "get this to Proms", the destination is "proms" (Padmanabhan owns the Proms leg) — Sharvan doing the first-leg warehouse pickup does NOT make it a warehouse case. A bare "@Sharvan we'll pick this lock" with no Proms mention stays "warehouse". Only relevant for reverse_pickup_pending.
- "active_sme": if a specific SME / trainer clearly worked this case (diagnosed, visited, or fixed it) — e.g. "Manohar fixed it", "Chandan visited", "Janmayjay handling PX" — return their first name only (e.g. "Manohar"). Only meaningful for revisit-audit / PX-quality cases where ONE named person is the actor. If no single SME is clearly the actor, null.
- "near_closure": true if the issue appears ESSENTIALLY DONE and only a final confirmation is missing — e.g. the replacement/spare was installed, the revisit was completed, the fix was applied, and the only remaining step is confirming with the customer that it's working. It is still OPEN (not yet confirmed), but the natural next question is simply "is this now resolved?". Otherwise false. Do NOT set this while real work is still pending (parts not delivered, revisit not done, RCA open).

WHO OWES THE NEXT ACTION — this decides who we TAG. Do these STEPS IN ORDER:

STEP 1 — FIND THE HANDOFF FIRST (before anything else). Look at the last ~4 messages of the thread. Is there an explicit "@Person please/kindly/pls <do something>" request — e.g. "@Padmanabhan align front panel from proms", "@Sindhu create revisit on dashboard", "@Rushali please check Iotfy / try these steps", "@Sneha share invoice"? If YES: the ADDRESSED person is next_actor, handoff=true. This OVERRIDES the escalation's default owners. Set next_actor to that addressed person and stop looking for other candidates.

STEP 2 — THE "Primary PoC" HEADER IS NOT THE NEXT ACTOR. The escalation root lists "Primary PoC" (usually Manuranjan + the SKU POC). Those are DEFAULT OWNERS for cc, NOT automatically next_actor. Do NOT tag them as the actor just because they're in the header — if a Step-1 handoff exists, the handoff person wins. Only fall back to the owners when there is genuinely no in-thread handoff and no specific person owes the next step.

STEP 3 — remaining rules below refine this. Read the LAST substantive request carefully:
- GROUNDING RULE: every name you put in next_actor or asked_by MUST be a person who literally appears as a message author or an @mention in the transcript above. NEVER invent or guess a name. If you are not certain a specific named person owes the next step, set handoff=false and next_actor=[] — do not fabricate.
- USE THE CURRENT (TAIL) STATE, NOT A STALE MID-THREAD STEP: long threads move through stages (e.g. "share invoice" → "approved, same model only" → "cx aligned, wants PX to install"). Anchor blocker, next_actor and current_status on the LATEST stage near the END of the thread. Do NOT resurface an earlier step that has already been superseded (e.g. do not say "waiting on invoice" if later messages show the replacement was approved and the conversation has moved to install/PX/next-order). Read the last several messages to find where it TRULY stands now.
- LAST POSTER ≠ NEXT ACTOR: next_actor is whoever was ASKED to do the pending step, not simply whoever posted most recently. Scan the LATEST real "@X please do Y" request and use X — that request is OFTEN the last message (use it then), but sometimes the last message is unrelated (a supervisor's process question, a customer-status relay, "any update?" chatter); in that case skip it and use the most recent genuine request. Judge by CONTENT, not position.
- NEVER pick Subhang / Subhang Reddy as next_actor. He is the supervisor who is cc'd on every escalation and never performs the field action (confirming with customers, filling sheets, delivering parts). If the pending step was addressed to an escalation agent (e.g. "@muskan please confirm with cx"), that AGENT is next_actor.
- ENGINEERING — CONSULT vs BLOCKER. Abhiram (alfadelta10010) and Gagan are Engineering. TWO different situations:
  (a) CONSULT (ignore): a POC pings them in passing ("@Abhiram check this", "@Gagan ++") while other work continues — do NOT make them next_actor; the customer-facing step still sits with the SKU POC / agent.
  (b) BLOCKER (route to them): the case is genuinely STUCK on Engineering — primary POCs explicitly handed it over and everyone is now waiting on Engineering's verdict (e.g. repeated "@alfadelta10010 need your help to check the logs", "please look into it, how do we resolve") with no one else owing a step. THEN set blocker=deep_firmware_rca (Abhiram) or entity_reset (Gagan, only if the reset itself is still pending) — the blocker's own POC handles tagging, so leave next_actor=[] / handoff=false and let the blocker route it. Use the CURRENT engineer: if the case moved from Gagan's (completed) reset to an Abhiram logs investigation, it's deep_firmware_rca (Abhiram), not entity_reset (Gagan).
- The rule: whoever must ACT NEXT to move the issue forward is "person B" — we TAG them. Everyone they unblock (the person who asked = "person A", plus the SKU POC) gets cc'd, not tagged.
- CRITICAL DIRECTION RULE: in a message like "@X please share the invoice" or "@X please replace the lock", the person MENTIONED/ADDRESSED (X) is person B (next_actor) — they must act. The AUTHOR of that message is person A (asked_by) — they are WAITING. NEVER swap these. The author who wrote "please share invoice" is NOT the one who owes the invoice; the person they addressed owes it. Example: "Manuranjan: @Rushali please share invoice" ⇒ next_actor=["Rushali"], asked_by="Manuranjan".
- COMPOUND "I DID X, @Y PLEASE DO Z" LINES: a message can report a completed action AND hand off the next one in the same breath — e.g. "Manuranjan: Replacement sheet filled row no 1566, @Sneha please share" or "@Sneha Replacement sheet filled ... please share". The author (Manuranjan) already did their part (filled the sheet); the PENDING step is what they asked the ADDRESSEE to do (Sneha to share the invoice). next_actor is the ADDRESSEE (Sneha), NOT the author — even though the author's name leads the sentence and they did the prior step. Example: "Manuranjan: @Sneha replacement sheet filled row 1566 please share" ⇒ next_actor=["Sneha"], asked_by="Manuranjan".
- MULTIPLE ADDRESSEES: if the request addresses SEVERAL people ("@Yuvraj @Rushali please share invoice"), ALL of them owe the action — return ALL their names in next_actor (e.g. ["Yuvraj Gupta","Rushali Chaurasia"]). Do not pick just one.
- "handoff": true if the latest substantive request addresses ANOTHER person (or people) to do/provide/drive something and we are now waiting on them — e.g. "@Sneha please share TAT with cx", "@X please share invoice", "@X please connect with cx", "@X please fill spare sheet", "@X please confirm ...", "@Sindhu please help here / align the px / check on this", "@X please look into this". A request phrased as "help"/"look into"/"align"/"check" still counts — the addressee owes the next step. Otherwise false.
- PX / VISIT COORDINATION: when the pending step is aligning or completing a PX / VSAT visit, and a specific person is coordinating that visit in the thread (e.g. Sindhu, or whoever keeps posting the visit-scheduling updates and was last asked "please align px for <date>"), THAT coordinator is next_actor — not the SKU POCs. The SKU POCs (Jyothi/Harsha) get cc'd, but the person who owns the visit scheduling is who we tag to confirm/align the visit. Do NOT default to asking the SKU POCs to "confirm visit completion" when a named coordinator owes the alignment.
- "next_actor": an ARRAY of DISPLAY NAMES of person(s) B (the ADDRESSEE(S) who must act next), each copied EXACTLY as it appears in the transcript (e.g. ["Rushali Chaurasia","Yuvraj Gupta"]). Must be the person(s) ADDRESSED in the request, not its author. Use a generic role word (["PX"] or ["logistics"]) only if truly no named person is addressed. If nobody specific, null or [].
- "next_action_needed": <=120 char — the concrete pending step person(s) B must do, REFRAMED in your own words as a crisp, closure-oriented instruction. Do NOT copy the thread's last line verbatim. Make it specific and complete: name the exact deliverable AND the missing detail needed to close (e.g. thread says "@Sneha please share" → "share the replacement invoice from the customer so the sheet can be processed"; thread says "@Rohit check debugger for wifi" → "check the connectivity debugger logs and confirm the RSSI/offline root cause with an ETA"; thread says "@Manohar align px" → "align a PX for the mortise-replacement visit and share the confirmed date/time"). Add the ETA/next-step ask where relevant. Improve on the raw request — make it the clearest possible version that drives closure. Null only if genuinely unclear.
- "asked_by": the DISPLAY NAME of person A (the AUTHOR who asked person B to act), exactly as in the transcript, or null. This person gets cc'd, never tagged as the actor.

Decide who the thread is currently WAITING ON (the person who owes the next action), by name if visible.

WRITE A SPECIFIC, EVIDENCE-BASED SUMMARY grounded in the WHOLE thread (read the root escalation AND every reply):
- "issue_reported": <=140 char — what the CUSTOMER originally reported (from the escalation/root message). The core problem. Do NOT copy relative-time words like "today"/"yesterday" verbatim from old messages (they mislead the reader about when it happened); rephrase neutrally (e.g. "back panel loose since installation") or use the actual date if visible.
- "steps_taken": <=300 char — a CHRONOLOGICAL synthesis of everything done/attempted across the thread, in order, reading EVERY reply. Include concrete actions and outcomes (e.g. "Diagnosed on call → auto-lock failing; PX revisit 30 Jul re-seated mortise but issue persisted; replacement approved, sheet row 1531 filled; spare dispatched, tracking 18127599232"). Name the actions and who did them where visible. Do NOT just restate the issue or paraphrase only the last message; cover the whole arc. If genuinely nothing was done, say "No substantive action taken yet."
- "current_status": <=140 char — where it stands RIGHT NOW and exactly what is missing/pending.
- "one_line": <=160 char — a single-line condensation of current_status (used in the digest).
- "ask": one situation-specific question for the blocked POC — the precise missing next step / ETA. Phrase it as a direct question WITHOUT addressing anyone by name (do NOT start with "Manuranjan," or "Jyothi," etc.); the system prepends the correct @mentions. Do NOT include raw Slack user IDs or <@...> mentions in any field.
- "last_activity": <=100 char paraphrase of the most recent substantive message + who sent it (digest only).

Return ONLY compact JSON:
{"status":"open|closed","blocker":"<key or null>","sku":"<sku or null>","pickup_dest":"proms|warehouse|null","active_sme":"<sme first name or null>","near_closure":true|false,"handoff":true|false,"next_actor":["<display name(s) who must act>"],"asked_by":"<display name of person who asked, or null>","next_action_needed":"<...>","waiting_on":"<name or role or null>","issue_reported":"<...>","steps_taken":"<...>","current_status":"<...>","one_line":"<...>","ask":"<...>","last_activity":"<...>"}`;

async function analyzeThread({ messages, nameOf, apiKey, model, provider }) {
  // Deterministic short-circuit: a withdrawn/ignore/duplicate escalation is
  // closed — don't spend an LLM call or nudge it. Critical keywords do NOT
  // override a withdrawal (a retracted ticket is retracted).
  if (isWithdrawn(messages)) {
    return { status: "closed", blocker: null, withdrawn: true };
  }
  const transcript = renderTranscript(messages, nameOf);
  const critical = scanCritical(transcript);
  const softFlag = scanSoftFlag(transcript);

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
  for (const f of ["issue_reported", "steps_taken", "current_status", "one_line", "ask", "last_activity", "next_action_needed"]) {
    parsed[f] = stripIds(parsed[f]);
  }

  // Critical override: if keywords fired, force-flag even if LLM said closed.
  if (critical.length) {
    parsed.critical = critical;
    if (parsed.status === "closed") parsed.status = "open";
  }
  // Soft flag: visible note only, no escalation. Prefer the deterministic scan;
  // it never fires the banner.
  if (softFlag) parsed.soft_flag = softFlag;
  return parsed;
}

module.exports = { analyzeThread, scanCritical, scanSoftFlag, renderTranscript };
