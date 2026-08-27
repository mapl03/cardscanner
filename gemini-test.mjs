/* Verifies the Gemini request shape and the Worker's gatekeeping, without
   touching the network. The AI layer is bundled against a fake `fetch` so the
   real src/ai.js is exercised; the Worker is imported directly.

     node gemini-test.mjs
*/

import * as esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  cond ? (pass++, console.log(`PASS  ${name}`))
       : (fail++, console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ""}`));
};

/* ------------------------------------------------- bundle the real src/ai.js */

await esbuild.build({
  entryPoints: ["src/ai.js"],
  bundle: true, format: "esm", outfile: "/tmp/ai-under-test.mjs",
  plugins: [{
    name: "stub-firebase",
    setup(b) {
      b.onResolve({ filter: /^\.\/firebase$/ }, () => ({ path: path.resolve("test-mocks/firebase-auth-stub.mjs") }));
    },
  }],
  define: { "import.meta.env.VITE_API_PROXY": '"https://proxy.test/"' },
  logLevel: "silent",
});

const ai = await import("/tmp/ai-under-test.mjs");

let sent = null;
let reply = null;
globalThis.fetch = async (url, init) => {
  sent = { url, ...init, json: JSON.parse(init.body) };
  return { ok: true, status: 200, json: async () => reply };
};

const geminiReply = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });

/* ---------------------------------------------------------------- identify */

reply = geminiReply(JSON.stringify({
  player: "Lionel Messi", club: "Inter Miami", manufacturer: "Topps",
  set: "Topps Chrome", season: "2025", cardNumber: "123", cardType: "Parallel",
  isRookie: false, isAutograph: true, isRelic: false, serialNumber: "23/50",
  printRun: 50, features: ["Gold refractor"], confidence: 0.91, uncertain: [],
}));

const tinyJpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";
const card = await ai.identifyCard(tinyJpeg, tinyJpeg);

ok("identify: parsed model output", card.player === "Lionel Messi" && card.printRun === 50);
ok("identify: bearer token attached", sent.headers.Authorization === "Bearer test-token");
ok("identify: model is a free-tier Flash model", /^gemini-[\d.]+-flash/.test(sent.json.model), sent.json.model);

const parts = sent.json.contents[0].parts;
ok("identify: two images sent, front then back",
  parts.filter((p) => p.inline_data).length === 2 &&
  parts[0].text.includes("FRONT") && parts[2].text.includes("BACK"));
ok("identify: images are raw base64, data URL prefix stripped",
  parts[1].inline_data.data.startsWith("/9j/") && !parts[1].inline_data.data.includes("base64,"));
ok("identify: mime type declared", parts[1].inline_data.mime_type === "image/jpeg");

const gc = sent.json.generationConfig;
ok("identify: structured output enforced by schema",
  gc.responseMimeType === "application/json" && gc.responseSchema.type === "OBJECT");
ok("identify: schema covers every card field the app reads",
  ["player","club","manufacturer","set","season","cardNumber","cardType","parallel",
   "serialNumber","printRun","isRookie","isAutograph","isRelic","confidence","uncertain"]
    .every((k) => k in gc.responseSchema.properties));
ok("identify: temperature pinned to 0", gc.temperature === 0);
ok("identify: no google_search tool on the vision call", !sent.json.tools);

/* ------------------------------------------------------------------- value */

reply = geminiReply('Here are the comps I found.\n```json\n' +
  '{"currency":"USD","low":80,"average":110,"high":150,"salesCount":6,' +
  '"insufficientData":false,"asOf":"2026-08-20","sources":[{"label":"eBay","url":"https://ebay.com"}],"comment":""}' +
  '\n```');

const v = await ai.estimateValue({ ...card, condition: "Near Mint", gradingCompany: "PSA", grade: "10" }, "EUR");
ok("value: JSON dug out of a grounded free-text reply", v.average === 110 && v.salesCount === 6);
ok("value: updatedAt stamped", typeof v.updatedAt === "string" && v.updatedAt.includes("T"));
ok("value: google_search grounding enabled",
  Array.isArray(sent.json.tools) && "google_search" in sent.json.tools[0]);
ok("value: no responseSchema — it cannot be combined with grounding",
  !sent.json.generationConfig.responseSchema);

const prompt = sent.json.contents[0].parts[0].text;
ok("value: card identity reaches the prompt",
  ["Lionel Messi", "Topps Chrome", "#123", "23/50"].every((s) => prompt.includes(s)), prompt.slice(0, 120));
ok("value: grade passed through", prompt.includes("PSA 10"));
ok("value: display currency requested", prompt.includes("Report in EUR"));
ok("value: model is forbidden from estimating", prompt.includes("Do not estimate"));

/* ------------------------------------------------------- failure behaviour */

reply = { candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] };
await ai.identifyCard(tinyJpeg, tinyJpeg).then(
  () => ok("truncated answer raises a clear error", false, "no error thrown"),
  (e) => ok("truncated answer raises a clear error", e.message.includes("cut short"), e.message));

reply = { promptFeedback: { blockReason: "SAFETY" } };
await ai.identifyCard(tinyJpeg, tinyJpeg).then(
  () => ok("blocked prompt raises a clear error", false, "no error thrown"),
  (e) => ok("blocked prompt raises a clear error", e.message.includes("SAFETY"), e.message));

globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: "Daily limit of 25 lookups reached." }) });
await ai.estimateValue(card, "EUR").then(
  () => ok("quota exhaustion surfaces the Worker's message", false, "no error thrown"),
  (e) => ok("quota exhaustion surfaces the Worker's message", e.message.includes("Daily limit of 25"), e.message));

/* ------------------------------------------------------------------ worker */

// Restore a clean fetch so the Worker's JWKS lookup is not answered by the
// 429 stub left over from the quota test above.
globalThis.fetch = async () => { throw new Error("network disabled in tests"); };

const worker = (await import("./worker/src/index.js")).default;
const ENV = { GEMINI_API_KEY: "secret", FIREBASE_PROJECT_ID: "card-scanner-b26ec",
  ALLOWED_ORIGINS: "https://mapl03.github.io" };
const ORIGIN = "https://mapl03.github.io";

const call = (opts = {}) => worker.fetch(new Request("https://api.test/", {
  method: opts.method || "POST",
  headers: { Origin: opts.origin ?? ORIGIN, ...(opts.auth === null ? {} : { Authorization: opts.auth || "Bearer x.y.z" }) },
  body: (opts.method === "OPTIONS" || opts.method === "GET") ? undefined
    : JSON.stringify(opts.body ?? { model: "gemini-2.5-flash", contents: [] }),
}), opts.env || ENV);

let r = await call({ method: "OPTIONS" });
ok("worker: CORS preflight allowed for your origin",
  r.status === 204 && r.headers.get("Access-Control-Allow-Origin") === ORIGIN);

r = await call({ origin: "https://evil.example" });
ok("worker: foreign origin rejected", r.status === 403);

r = await call({ auth: null });
ok("worker: request without a token rejected", r.status === 401);

r = await call({ auth: "Bearer not-a-real-jwt" });
ok("worker: forged token rejected", r.status === 401,
  `expected 401, got ${r.status}: ${JSON.stringify(await r.clone().json())}`);

r = await call({ env: { ...ENV, GEMINI_API_KEY: "" } });
ok("worker: missing key reported as a server fault, not a rejection", r.status === 500);

r = await call({ method: "GET" });
ok("worker: GET refused", r.status === 405);

const src = fs.readFileSync("worker/src/index.js", "utf8");
ok("worker: model allow-list blocks anything not free-tier Flash",
  src.includes('ALLOWED_MODELS') && src.includes('"gemini-2.5-flash"') && !src.includes("gemini-2.5-pro"));
ok("worker: key travels in the header, never the URL",
  src.includes('"x-goog-api-key": env.GEMINI_API_KEY') && !src.includes("?key="));
ok("worker: output tokens capped server-side", src.includes("MAX_OUTPUT_TOKENS_CAP"));
ok("worker: token signature actually verified, not just parsed",
  src.includes("crypto.subtle.verify") && src.includes("securetoken.google.com"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
