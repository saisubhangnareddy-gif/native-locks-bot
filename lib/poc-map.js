// ============================================================================
// POC MAP — single source of truth for who to tag on what.
//
// All Slack IDs verified against the live #native-lock-product-issues channel.
// The bot ALWAYS renders these as <@ID> mentions — raw IDs never shown to users.
// ============================================================================

const PEOPLE = {
  SUBHANG:      "U0B94EZ4L3X", // Nareddy Sai Subhang Reddy (you) — always cc
  SITA_RAM:     "U086EKJDRD2", // Sita Ram — cc ONLY on critical cases (never a primary tag)

  // POD / general RCA + replacement/spare owner
  MANURANJAN:   "U0B99EPHE5P", // Manuranjan — general RCA, replacement/spare/revisit alignment (POD)

  // Issue validation / primary RCA by SKU
  HARSHA:       "U08CYV7PW6Q", // Harshavardhan V — ULTRA (and default) primary RCA
  JYOTHI:       "U09MKC8333Q", // Jyothi Prakash Reddy — PRO primary RCA

  // Engineering
  ABHIRAM:      "U0973KBGHDF", // Abhiram Dasika — deep firmware/software RCA (only if POCs can't close)
  GAGAN:        "U09ET30GQS3", // Gagandeep (Engineering) — entity reset / config-flow

  // Leadership (critical)
  KUNAL:        "U09P8HVFHKK", // Kunal Chhonkar — critical lead
  BHASKAR:      "U06MHTAHUEA", // Bhaskar — L2/L3 / unknown-issue escalation

  // Logistics
  ROHIT_BISHT:  "U06T72X8KQS", // Rohit Singh Bisht — delivery / tracking / EDD / RTO
  SHARVAN:      "U07C5EE11AT", // Sharvan Negi — reverse pickup to WAREHOUSE (default)
  PADMANABHAN:  "U0ALH6RPALU", // Padmanabhan — reverse pickup to PROMS

  // SMEs — revisit audits, PX-led errors / quality checks only
  JANMAYJAY:    "U0AKQPQ7V3K", // Janmayjay Sharma — Trainer/SME
  VADLARAJU:    "U0AFCSSE2HG", // Vadlaraju — SME Trainer
  MANOHAR:      "U0AG9E0E1AT", // Manohar — SME
  SHAIKH:       "U065ZKWMXPY", // Shaikh Amirul — Trainer/SME
  CHANDAN:      "U096NUU5G2W", // Chandan Thakur — smart lock Trainer/SME
  ANEK:         "U0A2Q6QUTHR", // Anek — SME
};

// SMEs handle revisit audits + PX-led error/quality checks.
const SMES = [PEOPLE.VADLARAJU, PEOPLE.MANOHAR, PEOPLE.SHAIKH, PEOPLE.CHANDAN, PEOPLE.ANEK, PEOPLE.JANMAYJAY];

// Resolve a free-text SME name (from the analyzer's "active_sme" field) to a
// person ID. Matches on first name / substring so "Manohar", "manohar sir",
// "Chandan Thakur" all resolve. Returns null if no confident match.
const SME_NAME_TO_ID = [
  ["vadla", PEOPLE.VADLARAJU],
  ["manohar", PEOPLE.MANOHAR],
  ["shaikh", PEOPLE.SHAIKH],
  ["amirul", PEOPLE.SHAIKH],
  ["chandan", PEOPLE.CHANDAN],
  ["anek", PEOPLE.ANEK],
  ["janmay", PEOPLE.JANMAYJAY],
];
function smeIdForName(name) {
  const n = (name || "").toLowerCase().trim();
  if (!n) return null;
  for (const [key, id] of SME_NAME_TO_ID) {
    if (n.includes(key)) return id;
  }
  return null;
}

// SKU-based primary RCA routing.
//   ultra  -> Harshavardhan
//   pro    -> Jyothi + Harshavardhan
//   other/unknown -> Harshavardhan (fallback)
function rcaPocsForSku(sku) {
  const s = (sku || "").toLowerCase();
  if (s.includes("ultra")) return [PEOPLE.HARSHA];
  if (s.includes("pro")) return [PEOPLE.JYOTHI, PEOPLE.HARSHA];
  return [PEOPLE.HARSHA]; // any other SKU or ambiguous
}

// ----------------------------------------------------------------------------
// BLOCKERS — the state a thread can be stuck in, and who owns unblocking.
// `pocs` may be a static array OR a function(ctx) => array, where ctx = { sku,
// pickupDest } so routing can depend on SKU / pickup destination.
// ----------------------------------------------------------------------------
const BLOCKERS = {
  awaiting_diagnosis: {
    label: "Escalation raised but no diagnosis / next step yet",
    pocs: (ctx) => rcaPocsForSku(ctx.sku).concat(PEOPLE.MANURANJAN),
    ask: "could you validate the issue and advise the diagnosis / next step (revisit or replacement)?",
  },
  rca_not_closed: {
    label: "Issue validation / RCA open (SKU POC to confirm root cause & next step)",
    pocs: (ctx) => rcaPocsForSku(ctx.sku),
    ask: "the RCA is still open — could you confirm the root cause and whether a revisit or replacement is needed, with an ETA?",
  },
  deep_firmware_rca: {
    label: "Deep firmware / software RCA (Engineering) — POCs unable to close",
    pocs: [PEOPLE.ABHIRAM],
    ask: "primary RCA couldn't close this — could Engineering investigate the firmware/software root cause and share findings + ETA?",
  },
  entity_reset: {
    label: "Entity reset / configuration-flow stuck (Engineering)",
    pocs: [PEOPLE.GAGAN],
    ask: "could you reset the entity and confirm once done so the customer can complete configuration?",
  },
  replacement_not_assigned: {
    label: "Replacement not yet initiated / sheet not filled",
    pocs: [PEOPLE.MANURANJAN],
    ask: "could you confirm the replacement is initiated and the replacement sheet filled (row no.), with an ETA?",
  },
  replacement_delivery_pending: {
    label: "Replacement approved but delivery / tracking pending",
    pocs: [PEOPLE.ROHIT_BISHT],
    ask: "the replacement is approved — could you share the courier tracking ID and expected delivery date?",
  },
  spare_not_sent: {
    label: "Spare part (mortise / RF module / spring / strike plate / battery box) pending",
    pocs: [PEOPLE.MANURANJAN],
    ask: "could you confirm the spare sheet is filled and share dispatch / ETA for the spare part?",
  },
  revisit_not_aligned: {
    label: "Revisit needed but PX not yet aligned",
    // Manuranjan aligns the PX; keep the SKU RCA owner in the loop since they
    // usually called the revisit and own the diagnosis.
    pocs: (ctx) => [...new Set([PEOPLE.MANURANJAN, ...rcaPocsForSku(ctx.sku)])],
    ask: "could you align a PX for the revisit and share the visit date/time?",
  },
  revisit_eta_pending: {
    label: "Revisit assigned — ETA / completion not confirmed",
    pocs: (ctx) => [...new Set([PEOPLE.MANURANJAN, ...rcaPocsForSku(ctx.sku)])],
    ask: "the revisit is assigned — could you confirm the visit date/time or whether it's completed?",
  },
  revisit_audit_quality: {
    label: "Revisit audit / PX-led error / installation-quality check (SME)",
    // If the thread names the SME who actually worked the case, tag only that
    // person + the SKU RCA owner. Otherwise fall back to all SMEs (self-select).
    pocs: (ctx) => {
      const named = smeIdForName(ctx.activeSme);
      const base = named ? [named] : SMES;
      return [...new Set([...base, ...rcaPocsForSku(ctx.sku)])];
    },
    ask: "could you audit this revisit / PX work and confirm the corrective action or resolution status?",
  },
  reverse_pickup_pending: {
    label: "Defective unit reverse pickup pending",
    // Proms if the thread says so; otherwise warehouse (Sharvan).
    pocs: (ctx) => (ctx.pickupDest === "proms" ? [PEOPLE.PADMANABHAN] : [PEOPLE.SHARVAN]),
    ask: "could you confirm the reverse pickup of the defective unit is scheduled, and share the pickup date?",
  },
  delivery_delay: {
    label: "Delivery delayed / SLA breach / no tracking ID",
    pocs: [PEOPLE.ROHIT_BISHT],
    ask: "the delivery is delayed — could you share the latest tracking ID and revised EDD?",
  },
};

// ----------------------------------------------------------------------------
// CRITICAL — flagged at top of digest, nudged hardest.
// Per instruction: primary tags = Manuranjan + Kunal; Sita Ram cc only.
// ----------------------------------------------------------------------------
const CRITICAL_SIGNALS = {
  lockout: {
    label: "Lockout — customer cannot enter home",
    pocs: [PEOPLE.MANURANJAN, PEOPLE.KUNAL],
    keywords: ["lockout", "locked out", "cannot get inside", "can't get in", "mother pcb", "not opening", "unable to open"],
  },
  social_media_legal: {
    label: "Social-media / legal / consumer-court threat",
    pocs: [PEOPLE.MANURANJAN, PEOPLE.KUNAL],
    keywords: ["social media", "consumer court", "consumer forum", "legal", "twitter", "instagram", "linkedin", "defamation", "court case", "media"],
  },
};

// cc rule: Subhang always; Sita Ram only on critical.
const CRITICAL_CC = [PEOPLE.SUBHANG, PEOPLE.SITA_RAM];
const DEFAULT_CC = [PEOPLE.SUBHANG];

module.exports = { PEOPLE, SMES, BLOCKERS, CRITICAL_SIGNALS, CRITICAL_CC, DEFAULT_CC, rcaPocsForSku, smeIdForName };
