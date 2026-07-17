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

    // Token gate (2026-07-17): manual triggers used to be wide open — anyone
    // who found the URL could fire Gmail/Sheets/AI runs. Cron invocations use
    // the scheduled() handler above and never pass through here, so gating
    // fetch cannot affect the schedule. Fails closed if TRIGGER_SECRET is
    // unset. Pass ?token=… or Authorization: Bearer …
    const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const token = url.searchParams.get("token") || bearer;
    const authorized = Boolean(env.TRIGGER_SECRET) && token === env.TRIGGER_SECRET;

    // Self-test: synthesize a class-action message and run it through the
    // real alert pipeline. Exercises gmail.send scope without needing a
    // real class-action notice to land in spam.
    if (url.searchParams.get("selftest") === "1") {
      if (!authorized) return new Response("unauthorized", { status: 401 });
      ctx.waitUntil(runSelfTest(env));
      return new Response(
        `Self-test dispatched. A synthetic alert will be sent to ${CLASS_ACTION_RECIPIENT} ` +
        "if Account 1 matches that mailbox. Check logs and inbox.",
        { status: 200 }
      );
    }

    // Manual trigger: ?account=2 to run account 2, default is account 1
    if (url.pathname === "/__scheduled" || request.method === "POST") {
      if (!authorized) return new Response("unauthorized", { status: 401 });
      const manualNum = parseInt(url.searchParams.get("account") || "1", 10);
      const account = getAccountConfig(env, manualNum);
      ctx.waitUntil(processSpam(env, account));
      return new Response(`Spam harvester triggered for ${account.name}. Check logs with \`wrangler tail\`.`, {
        status: 200,
      });
    }
    return new Response(
      "Spam Email Extractor Worker (Multi-Account)\n" +
      "All manual triggers require ?token=… (SPAM_EXTRACTOR_TRIGGER_SECRET in mastermind .env)\n" +
      "POST /__scheduled?token=…            → trigger Account 1\n" +
      "POST /__scheduled?account=2&token=…  → trigger Account 2\n" +
      "GET  /?selftest=1&token=…            → send synthetic class-action alert (verifies gmail.send scope)",
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

    // 2. Identify the authenticated account. Class-action alert handling is
    //    restricted to CLASS_ACTION_RECIPIENT (the only account granted the
    //    `gmail.send` scope); other accounts skip that path entirely and
    //    behave exactly as the original spam harvester.
    const myEmail = await getMyEmailAddress(accessToken);
    const classActionEnabled =
      myEmail.toLowerCase() === CLASS_ACTION_RECIPIENT.toLowerCase();
    console.log(
      `[spam-extractor] [${account.name}] Authenticated as ${myEmail}; class-action alerts ${classActionEnabled ? "ENABLED" : "disabled"}`
    );

    // 3. Read existing emails from Sheet column A (spam sender dedup) and,
    //    only when class-action alerts are enabled, the previously-alerted
    //    class-action message IDs from column F.
    const existingEmails = await getExistingEmails(accessToken, account.sheetId);
    console.log(`[spam-extractor] [${account.name}] Found ${existingEmails.size} existing emails in sheet`);

    const alertedIds = classActionEnabled
      ? await getAlertedMessageIds(accessToken, account.sheetId)
      : new Set();
    if (classActionEnabled) {
      console.log(`[spam-extractor] [${account.name}] Found ${alertedIds.size} previously-alerted class-action IDs`);
    }

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

    // 5. Filter to only new (non-duplicate) senders.
    //    Class-action / settlement notices are LEFT in spam (so the catch
    //    stays intact) but trigger an alert email to the account owner so
    //    they don't miss a claim deadline. Excluded from the spam sheet.
    const newMessages = [];
    let skipped = 0;
    let alerted = 0;
    let alertSkippedDup = 0;
    const newAlertedIds = [];

    for (const msg of allMessages) {
      if (!msg) continue;

      if (classActionEnabled && looksLikeClassAction(msg.email, msg.subject, msg.snippet)) {
        if (alertedIds.has(msg.id)) {
          alertSkippedDup++;
          continue; // already alerted in a previous run
        }
        try {
          await sendClassActionAlert(accessToken, account, msg, myEmail);
          alertedIds.add(msg.id);
          newAlertedIds.push(msg.id);
          alerted++;
          console.log(
            `[spam-extractor] [${account.name}] ALERT sent for class-action: ${msg.email} | ${msg.subject}`
          );
        } catch (e) {
          console.error(
            `[spam-extractor] [${account.name}] Alert failed for ${msg.id} (${msg.email}): ${e.message}`
          );
        }
        continue;
      }

      if (existingEmails.has(msg.email.toLowerCase())) {
        skipped++;
        continue;
      }
      existingEmails.add(msg.email.toLowerCase());
      newMessages.push(msg);
    }

    if (classActionEnabled) {
      console.log(
        `[spam-extractor] [${account.name}] ${newMessages.length} new senders, ${skipped} duplicates, ${alerted} class-action alerts sent, ${alertSkippedDup} already-alerted`
      );
    } else {
      console.log(
        `[spam-extractor] [${account.name}] ${newMessages.length} new senders, ${skipped} duplicates`
      );
    }

    // Persist newly-alerted message IDs so we don't re-alert next run.
    if (classActionEnabled && newAlertedIds.length > 0) {
      try {
        await appendAlertedMessageIds(accessToken, account.sheetId, newAlertedIds);
      } catch (e) {
        console.error(
          `[spam-extractor] [${account.name}] Failed to persist alerted IDs: ${e.message}`
        );
      }
    }

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
      `[spam-extractor] [${account.name}] Harvest complete! Added: ${newRows.length}, Skipped: ${skipped}, Alerted: ${alerted}`
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

    // 1B model is plenty for extracting a single 1-5 digit; cheapest retained
    // Workers AI model after the May 30 2026 deprecation of llama-3-8b-instruct.
    const response = await ai.run("@cf/meta/llama-3.2-1b-instruct", {
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

// ─── Class-Action Alert ──────────────────────────────────────────────────────
//
// Gmail's spam filter routinely eats legitimate class-action / settlement
// notices because they look like bulk mail. Missing them costs real money
// (claim deadlines pass). We detect them by:
//   1. Subject keywords that are highly specific to settlement notices, or
//   2. Sender domain matching a known settlement-administrator firm.
// On match, we leave the original message in spam (so the catch stays
// intact) and send the account owner a heads-up email pointing to it.
// Dedup is via column F of the same Google Sheet so we don't re-alert on
// every cron tick until the message falls out of the top 25.
//
// Only enabled for one account — the other Google account in this worker
// is read-only and would 403 on `messages.send`.

export const CLASS_ACTION_RECIPIENT = "brandon@brandonernst.com";

const CLASS_ACTION_SUBJECT_PATTERNS = [
  /\bclass[-\s]action\b/i,
  /\bnotice of (proposed )?settlement\b/i,
  /\bnotice of class action\b/i,
  /\bsettlement administrator\b/i,
  /\bsettlement (notice|payment|fund|benefit|check)\b/i,
  /\bclaim (deadline|form|period)\b/i,
  /\bproof of claim\b/i,
  /\bcourt[-\s]approved notice\b/i,
  /\byou may be entitled to (compensation|payment|cash|money|a payment|benefits)\b/i,
  /\bif you (purchased|bought|used|owned|paid for|are a (member|class member))\b/i,
];

// Known U.S. class-action / settlement administrator domains. Mail from any
// of these is treated as a rescue regardless of subject.
const CLASS_ACTION_ADMIN_DOMAINS = new Set([
  "kccllc.com",
  "epiqglobal.com",
  "atticusadmin.com",
  "noticeadministrator.com",
  "verita-global.com",
  "veritaglobal.com",
  "kroll.com",
  "ra.kroll.com",
  "gcginc.com",
  "stretto.com",
  "primeclerk.com",
  "donlinrecano.com",
  "rg2claims.com",
  "rg2llc.com",
  "yourclassactionnotice.com",
  "classaction.org",
  "angeiongroup.com",
  "angeion-group.com",
  "jndla.com",
  "claimsadministrator.com",
  "a-bsettlement.com",
  "classactionrebates.com",
  "noticeadmin.com",
  "simpluris.com",
  "ilym.com",
  "rustconsulting.com",
]);

export function looksLikeClassAction(email, subject, snippet) {
  const domain = (email.split("@")[1] || "").toLowerCase();

  // Known administrator domain → rescue regardless of subject.
  if (CLASS_ACTION_ADMIN_DOMAINS.has(domain)) return true;
  for (const adminDomain of CLASS_ACTION_ADMIN_DOMAINS) {
    if (domain.endsWith("." + adminDomain)) return true;
  }

  // Subject match → strong signal on its own.
  for (const pattern of CLASS_ACTION_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) return true;
  }

  // Snippet match: require "class action" co-occurring with a second
  // settlement-flavored term to suppress false positives.
  const snippetText = snippet || "";
  if (
    /\bclass[-\s]action\b/i.test(snippetText) &&
    /(settlement|claim|notice|lawsuit|litigation|court)/i.test(snippetText)
  ) {
    return true;
  }

  return false;
}

async function getMyEmailAddress(accessToken) {
  const url = `${GMAIL_API}/users/me/profile`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Gmail profile ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.emailAddress) {
    throw new Error("No emailAddress in Gmail profile response");
  }
  return data.emailAddress;
}

async function getAlertedMessageIds(accessToken, sheetId) {
  // Column F of Sheet1 is reserved for class-action message IDs that have
  // already triggered an alert email. Reading an all-empty range returns no
  // values, so this is safe on first run before column F has anything in it.
  const url = `${SHEETS_API}/${sheetId}/values/Sheet1!F:F`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  const ids = new Set();
  if (data.values) {
    for (const row of data.values) {
      if (row[0]) ids.add(row[0]);
    }
  }
  return ids;
}

async function appendAlertedMessageIds(accessToken, sheetId, ids) {
  const url =
    `${SHEETS_API}/${sheetId}/values/Sheet1!F:F:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const rows = ids.map((id) => [id]);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    throw new Error(`Sheets F-append ${res.status}: ${await res.text()}`);
  }
}

async function sendClassActionAlert(accessToken, account, msg, myEmail) {
  const gmailLink = `https://mail.google.com/mail/u/${account.gmailUserIndex}/#spam/${msg.id}`;
  const safeSnippet = defangUrls(msg.snippet || "(no preview available)");
  const subjectLine = `⚠️ Possible class action in spam: ${msg.subject}`;

  const body = [
    "A potential class-action or settlement notice was detected in your",
    "spam folder. The original message has been left in spam — open the",
    "Gmail link below to review and move it to your inbox if it looks",
    "legitimate.",
    "",
    `From:    ${msg.email}`,
    `Subject: ${msg.subject}`,
    "",
    "Preview (URLs defanged for safety — do not click):",
    safeSnippet,
    "",
    "Open original in Gmail spam:",
    gmailLink,
    "",
    "--",
    "spam-email-extractor worker",
  ].join("\r\n");

  const raw = [
    `From: ${myEmail}`,
    `To: ${myEmail}`,
    `Subject: ${mimeEncodeHeader(subjectLine)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");

  const url = `${GMAIL_API}/users/me/messages/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: base64UrlEncode(raw) }),
  });

  if (!res.ok) {
    throw new Error(`Gmail send ${res.status}: ${await res.text()}`);
  }
}

// Defang URLs in untrusted snippet content so Gmail's auto-linker doesn't
// turn a spam phishing link into a clickable target inside our alert.
export function defangUrls(s) {
  return s.replace(/https?/gi, (m) => m.replace(/t/g, "x").replace(/T/g, "X"));
}

export function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Self-test: synthesize a class-action message and exercise the alert
// pipeline end-to-end. Only sends if Account 1 authenticates as the
// configured recipient — otherwise aborts loudly.
async function runSelfTest(env) {
  try {
    const account = getAccountConfig(env, 1);
    const accessToken = await getGoogleAccessToken(account);
    const myEmail = await getMyEmailAddress(accessToken);
    if (myEmail.toLowerCase() !== CLASS_ACTION_RECIPIENT.toLowerCase()) {
      console.error(
        `[selftest] Account 1 authenticates as ${myEmail}, not ${CLASS_ACTION_RECIPIENT}. Aborting.`
      );
      return;
    }
    const synthetic = {
      id: "selftest-" + Date.now(),
      email: "self-test@spam-extractor.local",
      subject: "spam-extractor self-test (safe to delete)",
      snippet:
        "If you received this, the gmail.send scope and the class-action " +
        "alert pipeline are wired up correctly. Visit http://example.com to " +
        "confirm URL defanging works. Safe to delete.",
    };
    console.log(`[selftest] sending synthetic alert to ${myEmail}`);
    await sendClassActionAlert(accessToken, account, synthetic, myEmail);
    console.log(`[selftest] ✓ alert sent`);
  } catch (e) {
    console.error(`[selftest] FAILED: ${e.message}`);
  }
}

// RFC 2047 'B' encoding so non-ASCII characters in the subject (the ⚠️
// emoji, accented characters in the original subject, etc.) survive transit.
export function mimeEncodeHeader(s) {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return "=?UTF-8?B?" + btoa(binary) + "?=";
}
