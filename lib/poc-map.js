// ============================================================================
// POC MAP — single source of truth for who to tag on what.
//
// Derived from the live #native-lock-product-issues channel + the
// "Smart Locks - Escalations POD Playbook" sheet + portal auto-assigned POCs.
//
// >>> REVIEW EVERY ID BELOW BEFORE FIRST REAL RUN. <<<
// IDs marked CONFIRM are inferred and should be verified against Slack.
// To get a user's ID in Slack: click profile -> More -> Copy member ID.
// ============================================================================

// People (Slack user IDs observed in-channel).
const PEOPLE = {
  SUBHANG:      "U0B94EZ4L3X", // Nareddy Sai Subhang Reddy (you) — always cc
  SITA_RAM:     "U086EKJDRD2", // Sita Ram — cc on re-nudge / no-response cases
  MANURANJAN:   "U0B99EPHE5P", // Manuranjan — replacement/spare sheet owner, general SME
  YOGESH:       "U066W93S3TM", // Yogesh Tomar — L2 / lockout mandatory call
  KUNAL:        "U09P8HVFHKK", // Kunal Chhonkar — lead / lockout call / RCA sign-off
  BHASKAR:      "U06MHTAHUEA", // Bhaskar — tech / RCA
  ABHIRAM:      "U0973KBGHDF", // Abhiram (Engineering) — firmware RCA / tech debug when tagged
  ROHIT_BISHT:  "U06T72X8KQS", // Rohit Singh Bisht — delivery / logistics (tracking, EDD, RTO)
  SHARVAN:      "U07C5EE11AT", // Sharvan Negi — reverse pickup / defective unit pickup
  PADMANABHAN:  "U0ALH6RPALU", // Padmanabhan — reverse pickup sheet
  JYOTHI:       "U09MKC8333Q", // Jyothi Prakash Reddy — SME diagnosis (mortise, wifi)
  HARSHA:       "U08CYV7PW6Q", // Harshavardhan V — SME, camera firmware ("tag Harsha")
  JANMAYJAY:    "U0AKQPQ7V3K", // Janmayjay Sharma — trainer, PX / revisit alignment
  VADLARAJU:    "U0AFCSSE2HG", // Vadlaraju — SME trainer, PX quality / install issues
  // NOTE: U0A1MUKPNRW (Mayank) is leaving — his role is being taken over by
  // Subhang, so that responsibility now maps to PEOPLE.SUBHANG below.
};

// Escalation ladder for no-response re-nudges (SME -> L2 -> L3).
// When a POC doesn't reply and we re-nudge, we also cc the next rung + Sita Ram.
const LADDER = [PEOPLE.MANURANJAN, PEOPLE.YOGESH, PEOPLE.KUNAL, PEOPLE.SITA_RAM];

// ----------------------------------------------------------------------------
// BLOCKER ROLES — the "state" a thread can be stuck in, and who owns unblocking.
// The classifier (see stuck-detector.js) maps a thread to one of these keys.
// ----------------------------------------------------------------------------
const BLOCKERS = {
  replacement_not_assigned: {
    label: "Replacement not yet initiated / sheet not filled",
    pocs: [PEOPLE.MANURANJAN],
    ask: "could you confirm if the replacement has been initiated and the replacement sheet filled (row no.)? If not, what's the ETA?",
  },
  replacement_delivery_pending: {
    label: "Replacement approved but delivery/tracking pending",
    pocs: [PEOPLE.ROHIT_BISHT],
    ask: "the replacement is approved — could you share the tracking ID and expected delivery date (EDD)? Customer is waiting.",
  },
  spare_not_sent: {
    label: "Spare part (mortise / RF module / spring / strike plate) pending",
    pocs: [PEOPLE.MANURANJAN],
    ask: "the spare part is pending — could you confirm the spare sheet is filled and share dispatch/ETA?",
  },
  revisit_not_aligned: {
    label: "Revisit needed but PX not yet aligned",
    pocs: [PEOPLE.JANMAYJAY, PEOPLE.HARSHA],
    ask: "could you align a PX for the revisit and share the visit date/time? Customer is waiting for a slot.",
  },
  revisit_eta_pending: {
    label: "Revisit assigned — ETA / completion status not confirmed",
    pocs: [PEOPLE.JANMAYJAY],
    ask: "the revisit is assigned — could you confirm the visit date/time, or whether it's been completed?",
  },
  rca_not_closed: {
    label: "RCA / tech investigation open (battery drain, PCB, camera/firmware, etc.)",
    // Firmware/camera RCA -> Abhiram (Engineering). Battery/PCB RCA -> Bhaskar.
    pocs: [PEOPLE.ABHIRAM, PEOPLE.BHASKAR],
    ask: "the RCA is still open — could you share the current status and an ETA for closure?",
  },
  reverse_pickup_pending: {
    label: "Defective unit reverse pickup pending",
    pocs: [PEOPLE.SHARVAN, PEOPLE.PADMANABHAN],
    ask: "could you confirm the reverse pickup of the defective unit is scheduled, and share the pickup date?",
  },
  delivery_delay: {
    label: "Delivery delayed / SLA breach / no tracking ID",
    pocs: [PEOPLE.ROHIT_BISHT],
    ask: "the delivery is delayed — could you share the latest tracking ID and revised EDD?",
  },
  awaiting_diagnosis: {
    label: "Escalation raised but no diagnosis/next step given yet",
    pocs: [PEOPLE.MANURANJAN, PEOPLE.JYOTHI],
    ask: "this escalation doesn't have a next step yet — could you review and advise the diagnosis / next action?",
  },
  install_quality: {
    label: "Install-quality / PX-fault issue needs PX accountability",
    pocs: [PEOPLE.VADLARAJU, PEOPLE.JANMAYJAY],
    ask: "this looks like an install-quality issue — could you check with the PX and confirm the corrective action?",
  },
};

// ----------------------------------------------------------------------------
// CRITICAL classification — these get flagged at top of digest & nudged hardest.
// ----------------------------------------------------------------------------
const CRITICAL_SIGNALS = {
  lockout: {
    label: "Lockout — customer cannot enter home",
    // Lockout SOP: call (not just tag) Kunal, Yogesh, Manuranjan on every case.
    pocs: [PEOPLE.KUNAL, PEOPLE.YOGESH, PEOPLE.MANURANJAN],
    keywords: ["lockout", "locked out", "cannot get inside", "can't get in", "mother pcb", "not opening", "unable to open"],
  },
  social_media_legal: {
    label: "Social-media / legal / consumer-court threat",
    pocs: [PEOPLE.SITA_RAM, PEOPLE.KUNAL],
    keywords: ["social media", "consumer court", "consumer forum", "legal", "twitter", "instagram", "linkedin", "defamation", "court case", "media"],
  },
};

module.exports = { PEOPLE, LADDER, BLOCKERS, CRITICAL_SIGNALS };
