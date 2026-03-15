/**
 * Spam Email Extractor — Cloudflare Worker
 *
 * Runs every 12 hours via cron trigger.
 * 1. Reads spam from Gmail
 * 2. Deduplicates by sender email against Google Sheet
 * 3. Rates each new spam message 1-10 using Cloudflare AI
 * 4. Appends [email, subject, rating, gmail_link] to the Sheet
 *
 * AI budget: max 20 emails/run × 2 runs/day = 40 AI calls/day
 * ≈ 2,000–3,200 neurons/day (well under 50% of 10,000 free)
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_EMAILS_PER_RUN = 20;
const SNIPPET_MAX_CHARS = 500;

export default {
  /**
   * Cron trigger handler — runs every 12 hours
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processSpam(env));
  },

  /**
   * HTTP handler — for manual testing via curl or browser
   */
  async fetch(request, env, ctx) {
    // Allow manual trigger via POST or via the /__scheduled test path
    const url = new URL(request.url);
    if (url.pathname === "/__scheduled" || request.method === "POST") {
      ctx.waitUntil(processSpam(env));
      return new Response("Spam harvester triggered. Check logs with `wrangler tail`.", {
        status: 200,
      });
    }
    return new Response(
      "Spam Email Extractor Worker is running.\nPOST to this URL or visit /__scheduled to trigger manually.",
      { status: 200 }
    );
  },
};

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function processSpam(env) {
  try {
    console.log("[spam-extractor] Starting spam harvest...");

    // 1. Get fresh Google access token
    const accessToken = await getGoogleAccessToken(env);
    console.log("[spam-extractor] Got Google access token");

    // 2. Read existing emails from Sheet column A (dedup set)
    const existingEmails = await getExistingEmails(accessToken, env.SHEET_ID);
    console.log(`[spam-extractor] Found ${existingEmails.size} existing emails in sheet`);

    // 3. Fetch spam message IDs from Gmail
    const messageIds = await getSpamMessageIds(accessToken);
    console.log(`[spam-extractor] Found ${messageIds.length} spam messages in Gmail`);

    if (messageIds.length === 0) {
      console.log("[spam-extractor] No spam found. Exiting.");
      return;
    }

    // 4. Process each message
    let added = 0;
    let skipped = 0;

    for (const msgId of messageIds) {
      const msgData = await getMessageDetails(accessToken, msgId);
      if (!msgData) continue;

      const { email, subject, snippet } = msgData;

      // Dedup check by sender email
      if (existingEmails.has(email.toLowerCase())) {
        skipped++;
        continue;
      }

      // 5. Ask Cloudflare AI for spam rating (only for new senders)
      const rating = await getSpamRating(env.AI, subject, snippet);

      // 6. Build Gmail link (u/0 = default account)
      const gmailLink = `https://mail.google.com/mail/u/0/#spam/${msgId}`;

      // 7. Append row to Google Sheet
      await appendToSheet(accessToken, env.SHEET_ID, [email, subject, rating, gmailLink]);

      // Track in memory to avoid dupes within the same run
      existingEmails.add(email.toLowerCase());
      added++;

      console.log(`[spam-extractor] Added: ${email} (rating: ${rating})`);
    }

    console.log(
      `[spam-extractor] Harvest complete! Added: ${added}, Skipped (duplicates): ${skipped}`
    );
  } catch (err) {
    console.error(`[spam-extractor] Error: ${err.message}`, err.stack);
  }
}

// ─── Google Auth ─────────────────────────────────────────────────────────────

async function getGoogleAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.G_CLIENT_ID,
      client_secret: env.G_CLIENT_SECRET,
      refresh_token: env.G_REFRESH_TOKEN,
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

async function appendToSheet(accessToken, sheetId, rowValues) {
  const url = `${SHEETS_API}/${sheetId}/values/Sheet1!A:D:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [rowValues] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${errText}`);
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

async function getMessageDetails(accessToken, messageId) {
  const url = `${GMAIL_API}/users/me/messages/${messageId}?format=full`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  if (!data.payload || !data.payload.headers) return null;

  const headers = data.payload.headers;
  const rawFrom = headers.find((h) => h.name === "From")?.value || "";
  const subject = headers.find((h) => h.name === "Subject")?.value || "(No Subject)";

  // Extract clean email address using regex
  const emailMatch = rawFrom.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (!emailMatch) return null;

  // Truncate snippet to save AI tokens
  const snippet = (data.snippet || "").substring(0, SNIPPET_MAX_CHARS);

  return {
    email: emailMatch[0],
    subject,
    snippet,
  };
}

// ─── Cloudflare AI ───────────────────────────────────────────────────────────

async function getSpamRating(ai, subject, snippet) {
  try {
    const prompt = `Rate this email's likelihood of being spam/malicious from 1-10 (10 = obvious spam). Reply with ONLY a single number.\n\nSubject: ${subject}\nPreview: ${snippet}`;

    const response = await ai.run("@cf/meta/llama-3-8b-instruct", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4,
    });

    // Extract just the number from the response
    const match = response.response.match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      return num >= 1 && num <= 10 ? String(num) : "N/A";
    }
    return "N/A";
  } catch (err) {
    console.error(`[spam-extractor] AI rating failed: ${err.message}`);
    return "ERR";
  }
}
