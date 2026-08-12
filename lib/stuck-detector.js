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
  // LOCKOUT is critical ONLY while the customer is still locked out — i.e.
  // BEFORE the resolution path (replacement / new-lock + refund) begins.
  // Once that is underway — replacement OR return/refund flow: any sheet filled,
  // approved, dispatched, reverse/return pickup aligned or done, tracking shared,
  // post-replacement RCA — the customer is no longer stuck outside; drop the
  // lockout critical. (Social-media/legal criticals are NOT stage-gated.)
  if (hits.includes("lockout")) {
    const pastReplacement = /(sheet fill|sheet filled|replacement approved|replacement.*deliver|deliver.*replacement|reverse pick|return pick|return sheet|refund|pick.*after replacement|tracking id|tracking \d|pickup done|pickup confirmed|proms for rca|replacement done|replacement lock installed|new lock|purchased.*lock)/i.test(t);
    if (pastReplacement) {
      const i = hits.indexOf("lockout");
      hits.splice(i, 1);
    }
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

// Deterministic resolution detector: the LAST substantive message clearly states
// the issue is resolved / done / working. Checked only at the tail so a
// mid-thread "resolved" that was later reopened doesn't wrongly close it.
// Conservative — requires an explicit resolution statement, not just "fixed the
// hub" mid-flow.
const RESOLVED_RE = /\b(issue resolved|successfully resolved|resolved.*(px visited|visit done)|(px visited|visit done).*resolved|issue (has been|is)[\w\s]{0,30}resolved|cx('s)? issue[\w\s]{0,30}resolved|cx confirmed.*(resolved|working|fine)|working (fine|now|properly|correctly)|lock is (now )?working|case closed|now resolved|problem (is )?resolved|take (a )?clos(ure|er)|please close this case|cx arranged.*(carpenter|technician).*(changed|replaced|fixed|installed))\b/i;
function isResolvedTail(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  // Look at the last 2 non-empty messages for a clear resolution statement.
  const tail = messages.slice(-2).map((m) => (m && m.text) || "");
  return tail.some((tx) => RESOLVED_RE.test(tx));
}

// The LAST message is a bare "visit done" / "px visited" — the pending revisit
// actually happened. We don't know for certain it fixed the issue, so this is
// NEAR-CLOSURE (ask to confirm), not hard-closed. Prevents re-nudging "create
// the revisit" when the revisit is already complete.
const VISIT_DONE_RE = /\b(visit done|px visited|revisit done|visit completed|px visit done|installation done|installed successfully)\b/i;
// Signals that work is still incomplete despite a "visit done" — if these
// appear at/near the tail, do NOT treat it as near-closure.
const INCOMPLETE_RE = /\b(out of (the )?city|will reschedule|reschedule the visit|uninstallation pending|pickup pending|not installed|still pending|cx cnr|not available)\b/i;
function isVisitDoneTail(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  const lastText = (messages[messages.length - 1] || {}).text || "";
  if (!VISIT_DONE_RE.test(lastText)) return false;
  // If the same last message also flags incompleteness, it's not closure.
  if (INCOMPLETE_RE.test(lastText)) return false;
  return true;
}

// The LAST substantive message is "replacement/return/spare sheet filled row
// no X" — the sheet is done, so the warehouse team dispatches automatically.
// There is nothing to nudge until a LATER message raises a new blocker
// (not delivered / install visit pending / etc.). If this is the tail, PARK it:
// stop nudging. Looks at the last 2 messages (a bot/system row may trail).
const SHEET_FILLED_RE = /\b(replacement|return|spare)\s+sheet\s+filled\s+row\s+no\.?\s*\d+/i;
function isSheetFilledTail(messages) {
  if (!Array.isArray(messages) || !messages.length) return false;
  const tail = messages.slice(-2).map((m) => (m && m.text) || "");
  return tail.some((tx) => SHEET_FILLED_RE.test(tx));
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

MULTIPLE ESCALATIONS IN ONE THREAD: sometimes a thread contains MORE THAN ONE escalation over time — an older issue (e.g. a Sept "handle/latch" case that was resolved) and then a NEW, DIFFERENT escalation posted later in the same thread (e.g. an Aug "lock freeze alerts" block with its own "Escalation Type / Issue Bucket / POC escalation time"). When this happens, focus ENTIRELY on the MOST RECENT escalation block and the messages after it. Do NOT merge the two — do not carry the old issue's steps (old mortise spare, old revisit) into the current one, and do not mix their statuses. issue_reported, steps_taken, current_status, blocker and next_actor must all describe the LATEST escalation only. A later escalation block with a fresh POC-escalation-time supersedes everything above it.

An escalation is CLOSED only if the thread clearly shows one of:
- customer confirmed the issue is resolved / working now / "case closed"
- an agent/SME/PX states the issue was fixed/resolved (e.g. "issue has now been resolved", "fixed by ...", "working fine now") — even if that message is in the MIDDLE of the thread, not the last one
- revisit was DONE and issue resolved (not just "revisit created/aligned")
- replacement was DELIVERED to customer and confirmed (not just "sheet filled" or "approved")
- spare part DELIVERED/installed and issue fixed
- a firm denial was given AND accepted, with no open customer demand
- someone confirms resolution in response to a "is this resolved?" style check — e.g. "yes", "yes resolved", "confirmed, working now", "cx confirmed it's fine"
- an SME/agent signals closure — "please take closure" (often typo'd "take closer"), "cx arranged their own carpenter and changed/fixed the part", "we can close this". These mean the fix is done; treat as CLOSED.
- the escalation was WITHDRAWN / retracted / marked ignore or duplicate — e.g. someone (especially the raiser) says "please ignore", "ignore this", "pls close", "duplicate ticket", "raised by mistake", "not needed". Treat these as CLOSED and stop nudging.
READ EVERY MESSAGE for a resolution statement — a "resolved"/"fixed" note anywhere in the thread means CLOSED unless a LATER message reopens it.

Otherwise it is OPEN. If OPEN, identify the single most accurate blocker state from this list:
${Object.entries(BLOCKERS).map(([k, v]) => `- ${k}: ${v.label}`).join("\n")}

ROUTING RULES — pick the blocker that matches the CURRENT stuck state:
- Fresh escalation, no substantive POC reply / next step => awaiting_diagnosis.
- IGNORE PROCESS / META CHATTER when deciding the pending step: messages like "please raise this from the portal", "use the portal", "please guide the agent", "raise on dashboard", spelling corrections, or wrong-installation-date scoldings are NOT the escalation's next step. They are housekeeping. The real pending step is the DIAGNOSIS / resolution of the CUSTOMER'S actual issue. Do NOT set next_actor to "guide someone on the portal" or similar — if the actual product issue still has no diagnosis, it's awaiting_diagnosis on the SKU POC, and next_actor should be [] (let the blocker route to the SKU POCs).
- Issue needs validation / root-cause by the SKU POC (is it real? revisit or replacement?) => rca_not_closed.
- DO NOT PRESCRIBE AN UNVALIDATED RESOLUTION. Only classify as a revisit/replacement/spare blocker if a POC in the thread has ACTUALLY decided that action is needed (e.g. "please create revisit", "please replace the lock", "fill spare sheet"). A CUSTOMER asking for a PX visit/replacement, an agent relaying "cx wants a visit", or your own inference is NOT validation — never invent a revisit/replacement/spare that no POC committed to. If the thread is still waiting on the SKU POC's verdict/update (people are asking "@POC any update?", "please check", "please help here" and the POC hasn't decided the next step), the blocker is rca_not_closed (or awaiting_diagnosis) and the ask is for the POC's UPDATE/verdict — NOT "align a revisit" or "replace the lock". Judge only by what POCs have confirmed, not what the customer requested.
- ONLY when primary POCs explicitly could not close it and it needs deep firmware/software/electronics/LOGS investigation by Engineering (PCB, firmware bug, signal logic, offline-logs analysis, MPCB/mother-PCB version or hardware-revision check) => deep_firmware_rca, tagged to Abhiram (alfadelta10010). Signals: someone explicitly asks "@alfadelta10010 / @Abhiram please check the logs / look into it / need your help to check", "check the mpcb version", or the case has clearly moved past routine steps into a logs/firmware/mpcb investigation. NOTE: when an Engineering step is the pending one (e.g. "@alfadelta can you check the mpcb version"), that is Abhiram's job — do NOT tag the agent (Sneha etc.) to do an Engineering task; set blocker=deep_firmware_rca so it routes to Abhiram. Do NOT use this for hardware/mechanical or discovery like "check debugger if it's RF module or lock bell" — that stays rca_not_closed with the SKU POC.
- ENTITY RESET vs LOGS RCA — do not confuse Gagan and Abhiram. Gagan does entity/config resets (mPIN, "entity stuck at registration"). If Gagan ALREADY did the reset and the case has since evolved into a WiFi-offline / logs / firmware investigation now handed to Abhiram, the CURRENT blocker is deep_firmware_rca (Abhiram) — NOT entity_reset (Gagan). Use the CURRENT tail state: whoever Engineering-side was LAST asked to investigate is the actor. Do not resurface Gagan's already-completed reset.
- Customer's config / setup / master-PIN / mPIN stuck needing an entity reset (and NOT yet done) => entity_reset (Gagan).
- "Replacement sheet filled row no X" but the parcel is still in transit / awaiting courier dispatch / tracking => replacement_delivery_pending.
- Replacement needed but not yet initiated / no sheet => replacement_not_assigned.
- "SHEET FILLED ROW NO X" MEANS THAT STEP IS DONE — never ask to fill it again. A message like "Replacement sheet filled row no 1573" or "spare sheet filled row 1317" is a COMPLETION report (the sheet IS filled). Do NOT set blocker=replacement_not_assigned / "sheet not filled" or ask anyone to "fill the sheet" after you see a row number. The next step is whatever comes AFTER filling (share invoice, dispatch, delivery, install) — route to that, tagging whoever was looped in on the completion line.
- ROHIT / DELIVERY IS NARROW: only route to delivery_delay or replacement_delivery_pending (Rohit Singh Bisht) when the thread EXPLICITLY shows a physical parcel ALREADY DISPATCHED and in transit with a courier tracking ID, and delivery is the stuck step. The following are NOT delivery cases and must NOT go to Rohit: "replacement approved", "sheet filled row X", "please share TAT/invoice/details", "share TAT with cx", pending on-site installation, or any step where an AGENT was asked to share/confirm something. Those are pre-dispatch handoffs — route by the actual pending step (usually the agent handoff, or replacement_not_assigned / revisit_not_aligned). If in doubt, do NOT pick Rohit.
- Spare part (mortise, RF module, spring, strike plate, battery box) requested but not confirmed dispatched => spare_not_sent.
- INSTALLATION vs DELIVERY — do NOT confuse them. If the replacement lock has ARRIVED/been approved and the stuck step is INSTALLING it at the customer (phrases like "lock not installed yet", "new lock installation pending", "install visit pending", "schedule installation", "align PX for installation") => this is a REVISIT alignment problem: revisit_not_aligned (no PX aligned) or revisit_eta_pending (visit booked but not done). It is NOT replacement_delivery_pending and NOT a delivery/logistics (Rohit) case. delivery_delay / replacement_delivery_pending / Rohit are ONLY for a physical parcel in transit with courier tracking, never for a pending on-site installation.
- Revisit NEEDED but no PX aligned => revisit_not_aligned. Revisit created/aligned but not done => revisit_eta_pending.
- A PX-led error, poor installation, property damage, OR a revisit audit / work-quality check => revisit_audit_quality.
- REFIT / FIELD-FIX ALREADY FAILED => SKU RCA, not an SME blast. If a PX already visited and re-fitted/replaced the part (mortise re-fitment, part swap) BUT the issue STILL persists ("issue occurs even after PX visit and mortise re-fitment", "even after refit still failing"), the field fix has been exhausted — this is now a root-cause question for the SKU POC. Set blocker=rca_not_closed (routes to the SKU RCA owner: Harshavardhan for Ultra, Jyothi+Harsha for Pro), NOT revisit_audit_quality (do not blast all SMEs when the on-site fix already failed).
- POST-REPLACEMENT / PROMS RCA IS ENGINEERING, NOT SME AUDIT: if the defective lock has been REPLACED and the OLD unit is being taken to Proms / examined for root-cause ("get this lock to proms for RCA", "reached proms", "let's RCA", "@Abhiram this is the case you have the lock and logs"), that is a deep hardware/firmware RCA owned by Engineering => deep_firmware_rca (Abhiram). Do NOT route this to the SME pool (revisit_audit_quality) — the SMEs audit field/PX work, not a returned-unit lab RCA.
- Defective unit reverse pickup pending => reverse_pickup_pending. (If BOTH install and old-unit pickup are pending, pick the step blocking progress first — usually the installation.)
- Delivery delayed / SLA breach / no tracking (a parcel in transit) => delivery_delay.
- Judge the LATEST state: a later message overrides earlier ones.

Also extract:
- "sku": the lock SKU if visible in the thread (e.g. "Native Lock Ultra", "Native Lock Pro", "Native Lock S"); else null. This decides RCA routing.
- "pickup_dest": the FINAL destination of the defective unit's reverse pickup. DEFAULT is "warehouse" (handled by Sharvan Negi). It is "proms" whenever the lock is ultimately going to the Proms office for physical RCA. Decide by these signals, in order: (1) if ANY message says the lock should go to Proms / "get this to proms" / "align it from Wh to Proms" / Padmanabhan is told to get/align it to Proms => "proms"; (2) else if the pickup is assigned only to Sharvan Negi (warehouse) with no Proms mention => "warehouse"; (3) if it literally says "proms" => "proms"; (4) otherwise => "warehouse". TWO-HOP RULE: the FINAL destination wins. If Sharvan is asked to pick from the customer BUT a message also says it's going "Wh to Proms" or "get this to Proms", the destination is "proms" (Padmanabhan owns the Proms leg) — Sharvan doing the first-leg warehouse pickup does NOT make it a warehouse case. A bare "@Sharvan we'll pick this lock" with no Proms mention stays "warehouse". Only relevant for reverse_pickup_pending.
- "active_sme": if a specific SME / trainer clearly worked this case (diagnosed, visited, or fixed it) — e.g. "Manohar fixed it", "Chandan visited", "Janmayjay handling PX" — return their first name only (e.g. "Manohar"). Only meaningful for revisit-audit / PX-quality cases where ONE named person is the actor. If no single SME is clearly the actor, null.
- "near_closure": true ONLY if the fix has ACTUALLY BEEN DONE and just needs a customer confirmation — the replacement/spare was INSTALLED, the revisit was COMPLETED ("visit done"), the fix was applied and works. A visit that is merely ALIGNED / SCHEDULED / "px will visit today" is NOT near_closure — the work hasn't happened yet, so it's still an open revisit (revisit_eta_pending). A pending 2nd replacement or an install visit not yet done is NOT near_closure. It is still OPEN (not yet confirmed), and the natural next question is "is this now resolved?". Otherwise false. Do NOT set this while real work is still pending (parts not delivered, revisit scheduled-but-not-done, RCA open). CRITICAL EXCEPTIONS — near_closure MUST be false if EITHER: (a) a NEW / different problem is raised in the LAST message(s) after the original fix (e.g. mortise replaced and "visit done", then "lock keeps going offline"); OR (b) AFTER a "visit done", later messages show work is STILL INCOMPLETE — "cx out of city / will reschedule", "uninstallation pending", "pickup pending", "still not installed", "cx cnr". A "visit done" that is later contradicted by pending install/pickup/reschedule is NOT closure — route to that pending step (revisit/pickup) instead.

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
  (c) RCA ALREADY DELIVERED (moved on): if Engineering has ALREADY posted their RCA findings/verdict and the thread has moved to an OPERATIONAL next step (e.g. "@Padmanabhan align the faulty battery", "@Rushali connect with cx to run the battery-isolation test", "replace the lock"), the blocker is NO LONGER deep_firmware_rca — it is that new step (spare_not_sent / reverse_pickup_pending / rca_not_closed / a handoff to the named person). Do NOT keep asking Engineering to "investigate" after they've given findings and handed it onward. next_actor = whoever was asked to do the operational step.
- The rule: whoever must ACT NEXT to move the issue forward is "person B" — we TAG them. Everyone they unblock (the person who asked = "person A", plus the SKU POC) gets cc'd, not tagged.
- CRITICAL DIRECTION RULE: in a message like "@X please share the invoice" or "@X please replace the lock", the person MENTIONED/ADDRESSED (X) is person B (next_actor) — they must act. The AUTHOR of that message is person A (asked_by) — they are WAITING. NEVER swap these. The author who wrote "please share invoice" is NOT the one who owes the invoice; the person they addressed owes it. Example: "Manuranjan: @Rushali please share invoice" ⇒ next_actor=["Rushali"], asked_by="Manuranjan".
- COMPOUND "I DID X, @Y PLEASE DO Z" LINES: a message can report a completed action AND hand off the next one in the same breath — e.g. "Manuranjan: Replacement sheet filled row no 1566, @Sneha please share" or "@Sneha Replacement sheet filled ... please share". The author (Manuranjan) already did their part (filled the sheet); the PENDING step is what they asked the ADDRESSEE to do (Sneha to share the invoice). next_actor is the ADDRESSEE (Sneha), NOT the author — even though the author's name leads the sentence and they did the prior step. Example: "Manuranjan: @Sneha replacement sheet filled row 1566 please share" ⇒ next_actor=["Sneha"], asked_by="Manuranjan".
- MULTIPLE ADDRESSEES: if the request addresses SEVERAL people ("@Yuvraj @Rushali please share invoice"), ALL of them owe the action — return ALL their names in next_actor (e.g. ["Yuvraj Gupta","Rushali Chaurasia"]). Do not pick just one.
- "handoff": true if the latest substantive request addresses ANOTHER person (or people) to do/provide/drive something and we are now waiting on them — e.g. "@Sneha please share TAT with cx", "@X please share invoice", "@X please connect with cx", "@X please fill spare sheet", "@X please confirm ...", "@Sindhu please help here / align the px / check on this", "@X please look into this". A request phrased as "help"/"look into"/"align"/"check" still counts — the addressee owes the next step. Otherwise false.
- PX / VISIT COORDINATION: when the pending step is aligning or completing a PX / VSAT visit, and a specific person is coordinating that visit in the thread (e.g. Sindhu, or whoever keeps posting the visit-scheduling updates and was last asked "please align px for <date>"), THAT coordinator is next_actor — not the SKU POCs. The SKU POCs (Jyothi/Harsha) get cc'd, but the person who owns the visit scheduling is who we tag to confirm/align the visit. Do NOT default to asking the SKU POCs to "confirm visit completion" when a named coordinator owes the alignment.
- "next_actor": an ARRAY of DISPLAY NAMES of person(s) B (the ADDRESSEE(S) who must act next), each copied EXACTLY as it appears in the transcript (e.g. ["Rushali Chaurasia","Yuvraj Gupta"]). Must be the person(s) ADDRESSED in the request, not its author. Use a generic role word (["PX"] or ["logistics"]) only if truly no named person is addressed. If nobody specific, null or [].
- "next_action_needed": <=120 char — the concrete pending step person(s) B must do, REFRAMED IN YOUR OWN WORDS as a crisp, closure-oriented instruction. This is the MOST IMPORTANT field for the nudge quality — you are an intelligent agent, NOT a copy-paste bot. NEVER echo the thread's last line verbatim. Rewrite it into the clearest, most actionable version, naming the exact deliverable + the missing detail/ETA needed to close. Examples of the reframe you MUST do:
  · last line "@yash confirm tried with unpairing and pairing" → "confirm whether unpair-repair of the RF module was tried, and if the issue persists, whether a revisit/replacement is needed"
  · last line "@Manohar fill the spare sheet mortise ... align asap or lock may get stuck" → "fill the mortise spare sheet and expedite dispatch — flagged risk of the lock getting stuck"
  · last line "@Rushali create revisit on the dashboard" → "create the revisit on the dashboard and share the confirmed visit date/time with the customer"
  · last line "@Sindhu confirm px visit" → "confirm the PX visit is completed and share the outcome / revised ETA"
Make it specific, add the ETA/closure ask, and improve on the raw request. Null only if genuinely unclear.
- "asked_by": the DISPLAY NAME of person A (the AUTHOR who asked person B to act), exactly as in the transcript, or null. This person gets cc'd, never tagged as the actor.

Decide who the thread is currently WAITING ON (the person who owes the next action), by name if visible.

WRITE A SPECIFIC, EVIDENCE-BASED SUMMARY grounded in the WHOLE thread (read the root escalation AND every reply):
- RELATIVE-DATE RULE (applies to EVERY field — current_status, next_action_needed, ask, one_line, etc.): NEVER copy relative-time words ("today", "tomorrow", "yesterday", "this evening", "in 30 min") from thread messages — those were written days ago and mislead about the current time. A message saying "px visit scheduled for today at 4pm" written last Thursday does NOT mean today. Resolve to the actual date if one is visible (e.g. "the Aug 7 visit"), else phrase neutrally ("the scheduled visit", "the pending visit"). When a scheduled visit's date is in the PAST relative to now, ask to CONFIRM THE OUTCOME of that past visit — not to complete a visit "today".
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
  // Deterministic resolution: a clear "issue resolved / px visited / working now"
  // at the tail closes it — overrides stale critical keywords earlier up-thread.
  if (isResolvedTail(messages)) {
    return { status: "closed", blocker: null, resolved: true };
  }
  // Replacement/return/spare sheet filled as the tail → PARKED. Warehouse
  // dispatches automatically; nothing to nudge until a later blocker appears.
  if (isSheetFilledTail(messages)) {
    return { status: "parked", blocker: null, sheet_filled: true };
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
      { role: "user", content: `CURRENT DATE/TIME (IST): ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" })}\nUse this to resolve relative dates ("today"/"tomorrow" in old messages are NOT the current date — a visit "scheduled today" written days ago is now in the past; ask to confirm its outcome).\n\nTHREAD TRANSCRIPT:\n${transcript}\n\nReturn the JSON now.` },
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

  // "visit done" at the tail: the revisit happened. Force near-closure and clear
  // any stale handoff so the nudge asks to CONFIRM resolution, not to re-create
  // the (already-completed) revisit. Overrides a stale revisit_not_aligned.
  if (isVisitDoneTail(messages)) {
    parsed.near_closure = true;
    parsed.handoff = false;
    parsed.next_actor = [];
    parsed.next_action_needed = null;
  }
  return parsed;
}

module.exports = { analyzeThread, scanCritical, scanSoftFlag, renderTranscript };
