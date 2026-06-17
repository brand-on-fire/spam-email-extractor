// Pre-deploy verification for the class-action alert path.
// Tests only the pure helpers — Google API calls are out of scope here
// (those get verified by tailing wrangler logs post-deploy).
//
// Run: node test/class-action.test.mjs   (from worker/)

import { strict as assert } from "node:assert";
import {
  CLASS_ACTION_RECIPIENT,
  looksLikeClassAction,
  defangUrls,
  base64UrlEncode,
  mimeEncodeHeader,
} from "../src/index.js";

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

// ─── Recipient constant ──────────────────────────────────────────────────────
console.log("Recipient gate");
check("CLASS_ACTION_RECIPIENT is brandon@brandonernst.com", () => {
  assert.equal(CLASS_ACTION_RECIPIENT, "brandon@brandonernst.com");
});

// ─── Detector — should match (positives) ─────────────────────────────────────
console.log("\nDetector: positive cases");
const positives = [
  // Known administrator domains
  ["notices@kccllc.com", "Update on your matter", "Hello"],
  ["notice@ra.kroll.com", "Important", "body"],
  ["x@notices.epiqglobal.com", "Notice", "body"], // subdomain of known
  ["claims@stretto.com", "Claim filed", "body"],
  ["info@jndla.com", "Settlement", "body"],

  // Subject keywords
  ["random@spam.com", "Class Action Settlement Notice", "body"],
  ["random@spam.com", "Notice of Proposed Settlement", "body"],
  ["random@spam.com", "Claim deadline approaching", "body"],
  ["x@y.com", "You may be entitled to compensation", "body"],
  ["x@y.com", "If you purchased a Pixel phone, read this", "body"],
  ["x@y.com", "Proof of claim required", "body"],
  ["x@y.com", "Settlement Administrator Notification", "body"],

  // Snippet co-occurrence
  [
    "x@y.com",
    "Important update",
    "You are a class action member of the Equifax settlement fund",
  ],
];

for (const [email, subj, snip] of positives) {
  check(`hit: ${email} | ${subj}`, () => {
    assert.equal(
      looksLikeClassAction(email, subj, snip),
      true,
      `expected detector to flag this`
    );
  });
}

// ─── Detector — should NOT match (negatives) ─────────────────────────────────
console.log("\nDetector: negative cases (must not false-positive)");
const negatives = [
  ["promo@deals.com", "Buy now! Limited time!", "50% off our amazing products"],
  ["no@reply.com", "Verify your account", "Click here to verify your bank"],
  ["news@example.com", "Weekly newsletter", "Top stories this week"],
  ["admin@class.school", "Class schedule update", "Your new schedule is ready"],
  ["x@spam.com", "First class flight deals", "Action required for booking"],
  ["x@spam.com", "Random subject", "Just a normal email body about cats"],
  ["x@kroll.com.fake.spam.com", "Update", "body"], // domain spoof — must not match
];

for (const [email, subj, snip] of negatives) {
  check(`miss: ${email} | ${subj}`, () => {
    assert.equal(
      looksLikeClassAction(email, subj, snip),
      false,
      `expected detector to skip this`
    );
  });
}

// ─── Defang ──────────────────────────────────────────────────────────────────
console.log("\nDefang URLs");
check("lowercase http", () => {
  assert.equal(defangUrls("Visit http://evil.com"), "Visit hxxp://evil.com");
});
check("lowercase https", () => {
  assert.equal(defangUrls("https://x.com"), "hxxps://x.com");
});
check("uppercase HTTPS", () => {
  assert.equal(defangUrls("HTTPS://X.COM"), "HXXPS://X.COM");
});
check("mixed", () => {
  assert.equal(defangUrls("HTTP://a https://b"), "HXXP://a hxxps://b");
});
check("no URL passthrough", () => {
  assert.equal(defangUrls("no urls here"), "no urls here");
});

// ─── base64UrlEncode ─────────────────────────────────────────────────────────
console.log("\nbase64UrlEncode");
check("URL-safe charset only", () => {
  const enc = base64UrlEncode("Hello, world! 🌍");
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
});
check("round-trips through base64", () => {
  const sample = "Hello, world! 🌍\nLine 2";
  const enc = base64UrlEncode(sample);
  // Convert URL-safe back to standard b64 for decode
  const std = enc.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const dec = Buffer.from(padded, "base64").toString("utf-8");
  assert.equal(dec, sample);
});

// ─── mimeEncodeHeader ────────────────────────────────────────────────────────
console.log("\nmimeEncodeHeader");
check("RFC 2047 'B' wrapper shape", () => {
  const hdr = mimeEncodeHeader("⚠️ Test Subject");
  assert.match(hdr, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});
check("decoded payload matches original", () => {
  const original = "⚠️ Possible class action in spam: Equifax Settlement";
  const hdr = mimeEncodeHeader(original);
  const inner = hdr.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  const decoded = Buffer.from(inner, "base64").toString("utf-8");
  assert.equal(decoded, original);
});

// ─── End-to-end: build the raw RFC 2822 message ──────────────────────────────
console.log("\nEnd-to-end RFC 2822 build (no send)");
check("constructs a valid raw message with all parts present", () => {
  const me = "brandon@brandonernst.com";
  const msg = {
    id: "abc123",
    email: "notice@kccllc.com",
    subject: "Important Settlement Notice",
    snippet: "Click http://malicious.example to claim your settlement.",
  };
  const safeSnippet = defangUrls(msg.snippet);
  const subjectLine = `⚠️ Possible class action in spam: ${msg.subject}`;
  const body = [
    `From:    ${msg.email}`,
    `Subject: ${msg.subject}`,
    "",
    "Preview:",
    safeSnippet,
  ].join("\r\n");
  const raw = [
    `From: ${me}`,
    `To: ${me}`,
    `Subject: ${mimeEncodeHeader(subjectLine)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");
  const encoded = base64UrlEncode(raw);

  // Decode and inspect
  const std = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64").toString("utf-8");

  assert.ok(decoded.startsWith(`From: ${me}`), "From line first");
  assert.ok(decoded.includes(`To: ${me}`), "To line present");
  assert.ok(/Subject: =\?UTF-8\?B\?/.test(decoded), "Subject MIME-encoded");
  assert.ok(decoded.includes("hxxp://malicious"), "snippet URL defanged");
  assert.ok(!decoded.includes("http://malicious"), "raw URL must NOT appear");
  assert.ok(decoded.includes("\r\n\r\n"), "blank line separates headers/body");
});

// ─── Summary ─────────────────────────────────────────────────────────────────
const status = process.exitCode ? "FAILED" : "PASSED";
console.log(`\n${status}: ${passed} checks passed${process.exitCode ? "" : ""}`);
