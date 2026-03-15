/**
 * Spam Email Extractor — Cloudflare Worker (Multi-Account)
 *
 * Two Google accounts, each running every 4 hours offset by 2 hours:
 *   Account 1: 0, 4, 8, 12, 16, 20 UTC  → /u/0/ links
 *   Account 2: 2, 6, 10, 14, 18, 22 UTC  → /u/1/ links
 *
 * Flow per account:
 * 1. Reads latest 25 spam emails from Gmail
 * 2. Deduplicates by sender email against that account's Google Sheet
 * 3. Rates each new sender 1-5 using Cloudflare AI
 * 4. Appends [email, subject, rating, gmail_link] to the Sheet
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_EMAILS_PER_RUN = 25;
const SNIPPET_MAX_CHARS = 500;
const BATCH_SIZE = 25;

// ─── Account Routing ─────────────────────────────────────────────────────────

// Account 1 runs at even-divisible-by-4 hours: 0, 4, 8, 12, 16, 20
// Account 2 runs at offset hours: 2, 6, 10, 14, 18, 22
function getAccountConfig(env, accountNum) {
  if (accountNum === 2) {
    return {
      name: "Account 2",
      clientId: env.G_CLIENT_ID_2,
      clientSecret: env.G_CLIENT_SECRET_2,
      refreshToken: env.G_REFRESH_TOKEN_2,
      sheetId: env.SHEET_ID_2,
      gmailUserIndex: "1", // /u/1/ for second logged-in account
    };
  }
  // Default: Account 1
  return {
    name: "Account 1",
    clientId: env.G_CLIENT_ID,
    clientSecret: env.G_CLIENT_SECRET,
    refreshToken: env.G_REFRESH_TOKEN,
    sheetId: env.SHEET_ID,
    gmailUserIndex: "0", // /u/0/ for default account
  };
}

function getAccountNumFromHour() {
  const hour = new Date().getUTCHours();
  // hours 0,4,8,12,16,20 → Account 1 | hours 2,6,10,14,18,22 → Account 2
  return (hour % 4 === 0) ? 1 : 2;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export default {
  async scheduled(event, env, ctx) {
    const accountNum = getAccountNumFromHour();
    const account = getAccountConfig(env, accountNum);
    ctx.waitUntil(processSpam(env, account));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Manual trigger: ?account=2 to run account 2, default is account 1
    if (url.pathname === "/__scheduled" || request.method === "POST") {
      const manualNum = parseInt(url.searchParams.get("account") || "1", 10);
      const account = getAccountConfig(env, manualNum);
      ctx.waitUntil(processSpam(env, account));
      return new Response(`Spam harvester triggered for ${account.name}. Check logs with \`wrangler tail\`.`, {
        status: 200,
      });
    }
    return new Response(
      "Spam Email Extractor Worker (Multi-Account)\n" +
      "POST /__scheduled          → trigger Account 1\n" +
      "POST /__scheduled?account=2 → trigger Account 2",
      { status: 200 }
    );
  },
};

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function processSpam(env, account) {
  try {
    console.log(`[spam-extractor] [${account.name}] Starting spam harvest...`);

    // 1. Get fresh Google access token
    const accessToken = await getGoogleAccessToken(account);
    console.log(`[spam-extractor] [${account.name}] Got Google access token`);

    // 2. Read existing emails from Sheet column A
    const existingEmails = await getExistingEmails(accessToken, account.sheetId);
    console.log(`[spam-extractor] [${account.name}] Found ${existingEmails.size} existing emails in sheet`);

    // 3. Fetch spam message IDs from Gmail
    const messageIds = await getSpamMessageIds(accessToken);
    console.log(`[spam-extractor] [${account.name}] Found ${messageIds.length} spam messages in Gmail`);

    if (messageIds.length === 0) {
      console.log(`[spam-extractor] [${account.name}] No spam found. Exiting.`);
      return;
    }

    // 4. Batch-fetch all message metadata
    const allMessages = await batchGetMessages(accessToken, messageIds);
    console.log(`[spam-extractor] [${account.name}] Fetched metadata for ${allMessages.length} messages`);

    // 5. Filter to only new (non-duplicate) senders
    const newMessages = [];
    let skipped = 0;

    for (const msg of allMessages) {
      if (!msg) continue;
      if (existingEmails.has(msg.email.toLowerCase())) {
        skipped++;
        continue;
      }
      existingEmails.add(msg.email.toLowerCase());
      newMessages.push(msg);
    }

    console.log(`[spam-extractor] [${account.name}] ${newMessages.length} new senders, ${skipped} duplicates`);

    if (newMessages.length === 0) {
      console.log(`[spam-extractor] [${account.name}] No new senders. Exiting.`);
      return;
    }

    // 6. Rate each new message with AI
    const maxAiCalls = 44;
    const newRows = [];

    for (let i = 0; i < newMessages.length && i < maxAiCalls; i++) {
      const msg = newMessages[i];
      const rating = await getSpamRating(env.AI, msg.subject, msg.snippet);
      const gmailLink = `https://mail.google.com/mail/u/${account.gmailUserIndex}/#spam/${msg.id}`;
      newRows.push([msg.email, msg.subject, rating, gmailLink]);
      console.log(`[spam-extractor] [${account.name}] Rated: ${msg.email} → ${rating}`);
    }

    if (newMessages.length > maxAiCalls) {
      console.log(`[spam-extractor] [${account.name}] ${newMessages.length - maxAiCalls} emails deferred to next run`);
    }

    // 7. Batch write all new rows to Sheet
    if (newRows.length > 0) {
      await batchAppendToSheet(accessToken, account.sheetId, newRows);
      console.log(`[spam-extractor] [${account.name}] Wrote ${newRows.length} rows to sheet`);
    }

    console.log(
      `[spam-extractor] [${account.name}] Harvest complete! Added: ${newRows.length}, Skipped: ${skipped}`
    );
  } catch (err) {
    console.error(`[spam-extractor] [${account.name}] Error: ${err.message}`, err.stack);
  }
}

// ─── Google Auth ─────────────────────────────────────────────────────────────

async function getGoogleAccessToken(account) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.clientId,
      client_secret: account.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ─── Google Sheets ───────────────────────────────────────────────────────────

async function getExistingEmails(accessToken, sheetId) {
  const url = `${SHEETS_API}/${sheetId}/values/Sheet1!A:A`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  const emails = new Set();

  if (data.values) {
    for (const row of data.values) {
      if (row[0]) {
        emails.add(row[0].toLowerCase());
      }
    }
  }

  return emails;
}

async function batchAppendToSheet(accessToken, sheetId, rows) {
  const url = `${SHEETS_API}/${sheetId}/values/Sheet1!A:D:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets batch append failed: ${res.status} ${errText}`);
  }
}

// ─── Gmail ───────────────────────────────────────────────────────────────────

async function getSpamMessageIds(accessToken) {
  const url = `${GMAIL_API}/users/me/messages?q=in:spam&includeSpamTrash=true&maxResults=${MAX_EMAILS_PER_RUN}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  if (!data.messages) return [];
  return data.messages.map((m) => m.id);
}

async function batchGetMessages(accessToken, messageIds) {
  const results = [];

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const chunk = messageIds.slice(i, i + BATCH_SIZE);
    const boundary = "batch_spam_extractor_" + Date.now();

    let body = "";
    for (const msgId of chunk) {
      body += `--${boundary}\r\nContent-Type: application/http\r\n\r\nGET /gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject\r\n\r\n`;
    }
    body += `--${boundary}--`;

    const res = await fetch("https://www.googleapis.com/batch/gmail/v1", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });

    const responseText = await res.text();
    const parsed = parseBatchResponse(responseText, chunk);
    results.push(...parsed);
  }

  return results;
}

function parseBatchResponse(responseText, messageIds) {
  const results = [];
  const parts = responseText.split(/--batch_\S+/);

  let msgIndex = 0;
  for (const part of parts) {
    if (!part.trim() || part.trim() === "--") continue;

    const jsonMatch = part.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;

    try {
      const data = JSON.parse(jsonMatch[0]);

      if (data.payload && data.payload.headers) {
        const headers = data.payload.headers;
        const rawFrom = headers.find((h) => h.name === "From")?.value || "";
        const subject = headers.find((h) => h.name === "Subject")?.value || "(No Subject)";

        const emailMatch = rawFrom.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          const snippet = (data.snippet || "").substring(0, SNIPPET_MAX_CHARS);
          results.push({
            id: data.id || messageIds[msgIndex],
            email: emailMatch[0],
            subject,
            snippet,
          });
        }
      }
    } catch (e) {
      // Skip unparseable responses
    }
    msgIndex++;
  }

  return results;
}

// ─── Cloudflare AI ───────────────────────────────────────────────────────────

async function getSpamRating(ai, subject, snippet) {
  try {
    const prompt = `Rate this email's spam likelihood from 1-5 (5 = obvious spam). Reply with ONLY a single number.\n\nSubject: ${subject}\nPreview: ${snippet}`;

    const response = await ai.run("@cf/meta/llama-3-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4,
    });

    const match = response.response.match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      return num >= 1 && num <= 5 ? String(num) : "N/A";
    }
    return "N/A";
  } catch (err) {
    console.error(`[spam-extractor] AI rating failed: ${err.message}`);
    return "ERR";
  }
}
