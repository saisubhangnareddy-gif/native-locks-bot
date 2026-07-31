// Thin Slack Web API wrapper (no SDK dependency — uses fetch).
// Requires a Bot token (xoxb-...) from the "Native Locks Escalations" app with scopes:
//   channels:history, groups:history, channels:read, users:read,
//   chat:write, im:write  (im:write only needed for DM-draft mode)

const SLACK_API = "https://slack.com/api";

// Slack Web API is most compatible with form-encoded bodies across all methods
// (some read methods like conversations.replies reject JSON bodies with
// invalid_arguments). We encode uniformly and retry once on rate limits.
async function slack(method, token, params = {}) {
  const url = `${SLACK_API}/${method}`;
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") || 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const json = await res.json();
    if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
    return json;
  }
  throw new Error(`Slack ${method} failed: rate_limited after retries`);
}

// Fetch parent messages in a channel since `oldestTs` (paginated).
async function getChannelHistory(token, channel, oldestTs) {
  let messages = [];
  let cursor;
  do {
    const params = { channel, oldest: oldestTs, limit: 200, inclusive: true };
    if (cursor) params.cursor = cursor;
    const json = await slack("conversations.history", token, params);
    messages = messages.concat(json.messages || []);
    cursor = json.response_metadata && json.response_metadata.next_cursor;
  } while (cursor);
  return messages;
}

// Fetch all replies for a thread (paginated). Returns [parent, ...replies].
async function getThreadReplies(token, channel, threadTs) {
  let messages = [];
  let cursor;
  do {
    const params = { channel, ts: threadTs, limit: 200 };
    if (cursor) params.cursor = cursor;
    const json = await slack("conversations.replies", token, params);
    messages = messages.concat(json.messages || []);
    cursor = json.response_metadata && json.response_metadata.next_cursor;
  } while (cursor);
  return messages;
}

// Post a threaded reply into the channel.
async function postThreadReply(token, channel, threadTs, text) {
  return slack("chat.postMessage", token, {
    channel,
    thread_ts: threadTs,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
}

// Post a standalone message (used for the daily digest channel).
async function postMessage(token, channel, text, blocks) {
  const params = { channel, text, unfurl_links: false, unfurl_media: false };
  if (blocks) params.blocks = blocks;
  return slack("chat.postMessage", token, params);
}

// Open a DM channel with a user and send a message (draft-approval mode).
async function dmUser(token, userId, text, blocks) {
  const open = await slack("conversations.open", token, { users: userId });
  const channel = open.channel.id;
  return postMessage(token, channel, text, blocks);
}

// Resolve display names for a set of user IDs (best-effort, cached per run).
async function getUserNames(token, userIds) {
  const names = {};
  await Promise.all(
    [...new Set(userIds)].map(async (id) => {
      try {
        const json = await slack("users.info", token, { user: id });
        names[id] = json.user.profile.display_name || json.user.real_name || id;
      } catch {
        names[id] = id;
      }
    })
  );
  return names;
}

module.exports = {
  getChannelHistory,
  getThreadReplies,
  postThreadReply,
  postMessage,
  dmUser,
  getUserNames,
};
