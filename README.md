# Native Locks Escalation Bot

Thread-summariser + POC nudger + daily digest for the **#native-lock-product-issues**
channel, powered by the existing **Native Locks Escalations** Slack app.

Two jobs:
1. **Nudger** (`/api/nudge`) — scans threads with activity in the last 5 days, uses
   Gemini to decide (from thread text only) whether each escalation is closed. For
   open ones it figures out *what it's stuck on* and *who it's blocked on*, then
   drafts a nudge tagging that POC + asking for ETA/next step, always cc'ing you.
   Re-nudges the same POC (cc Sita Ram) if they didn't reply since the last nudge.
2. **Digest** (`/api/digest`) — every morning posts a categorized summary
   (Critical first, then product issues by blocker, each with POC + thread link)
   to **#pending-escalations-summariser**.

Both start in **draft mode**: they DM *you* the proposed messages instead of
posting. Flip to `auto` once you trust it.

## How "stuck" is decided
Purely from thread text (no sheets). Closed = customer confirmed resolved / revisit
done / replacement delivered / spare delivered / accepted denial. Everything else is
open and gets classified into a blocker (see `lib/poc-map.js` → `BLOCKERS`). A
keyword pre-scan force-flags lockouts and social-media/legal threats even if the LLM
is unsure.

## Setup (Vercel, same account as native-locks-sop)

1. **Slack app scopes** — in the Native Locks Escalations app (`A0BHKG8BMNV`) add Bot
   Token scopes: `channels:history`, `channels:read`, `users:read`, `chat:write`,
   `im:write`. Reinstall the app. Copy the **Bot User OAuth Token** (`xoxb-...`).
   Invite the app to both channels: `/invite @Native Locks Escalations`.
2. **Deploy** — push this folder to a new GitHub repo and import it in Vercel (or
   `vercel deploy`). It's zero-dependency (native `fetch`, Node 18+).
3. **Env vars** — set everything in `.env.example` in Vercel → Settings → Environment
   Variables.
4. **KV (optional but recommended)** — add Vercel KV so re-nudge memory persists;
   paste `KV_REST_API_URL` / `KV_REST_API_TOKEN`. Without it, re-nudge detection is
   disabled (every run treats threads as first-time).
5. **Cron** — `vercel.json` already schedules digest at **04:30 UTC = 10:00 AM IST**
   and nudger at **12:30 UTC = 6:00 PM IST**. Vercel Cron runs in UTC; adjust there.

## Reviewing before going live
- Confirm every Slack ID in `lib/poc-map.js` if the team changes. All current IDs
  are verified against live channel activity.
- Trigger manually: `GET /api/nudge?key=<CRON_SECRET>` and `/api/digest?key=...`.
  In draft mode you'll get a DM with the proposed output.
- When happy, set `NUDGE_MODE=auto` and/or `DIGEST_MODE=auto`.

## Tuning
- `LOOKBACK_DAYS` — window size.
- Blocker labels / POCs / ask-phrasing — all in `lib/poc-map.js`.
- Classification rules — the system prompt in `lib/stuck-detector.js`.
