import { auth } from "./firebase";

/* ============================================================================
   AI layer — Google Gemini.

   Requests go to your own Cloudflare Worker, never to Google directly: the API
   key lives in the Worker, and the Worker refuses anything without a valid
   Firebase ID token. Calling the Gemini endpoint from the browser would mean
   shipping the key to every visitor.

   Two calls, deliberately different:

   IDENTIFY  uses responseSchema, so Gemini is structurally unable to return
             anything but the shape we asked for. No parsing guesswork.

   VALUE     uses the google_search tool, which cannot be combined with
             responseSchema — grounded answers come back as free text, so the
             JSON is dug out of the reply instead.
============================================================================ */

const PROXY = import.meta.env.VITE_API_PROXY || "";

// Free-tier workhorses. Flash reads small print on card backs noticeably
// better; switch to gemini-2.5-flash-lite if you start hitting the daily cap.
const MODEL_VISION = "gemini-2.5-flash";
const MODEL_SEARCH = "gemini-2.5-flash";

export const proxyConfigured = !!PROXY;

function dataUrlToBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in model response");
  return JSON.parse(text.slice(start, end + 1));
}

async function callGemini(model, body) {
  if (!PROXY) throw new Error("VITE_API_PROXY is not set");
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");
  const token = await user.getIdToken();

  const res = await fetch(PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, ...body }),
  });

  if (res.status === 429) {
    const info = await res.json().catch(() => ({}));
    throw new Error(info.error || "Daily limit reached. The free Gemini quota resets each day.");
  }
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw new Error(info.error || `Lookup failed (${res.status})`);
  }

  const data = await res.json();

  // A prompt can be blocked outright, before any candidate is produced.
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error(`Blocked by safety filter: ${data.promptFeedback.blockReason}`);
  }

  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error("Model returned no answer");

  const text = ((cand.content && cand.content.parts) || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  // MAX_TOKENS with empty text means the budget ran out mid-answer. Say so
  // rather than failing later with a confusing JSON parse error.
  if (!text) {
    throw new Error(
      cand.finishReason === "MAX_TOKENS"
        ? "Answer was cut short. Raise maxOutputTokens in src/ai.js."
        : `Model returned nothing (${cand.finishReason || "unknown reason"})`
    );
  }
  return text;
}

/* ---------------------------------------------------------------- identify */

const NULLABLE_STRING = { type: "STRING", nullable: true };

const CARD_SCHEMA = {
  type: "OBJECT",
  properties: {
    player: NULLABLE_STRING,
    club: NULLABLE_STRING,
    nationalTeam: NULLABLE_STRING,
    manufacturer: NULLABLE_STRING,
    set: NULLABLE_STRING,
    season: NULLABLE_STRING,
    cardNumber: NULLABLE_STRING,
    cardType: {
      type: "STRING", nullable: true,
      enum: ["Base", "Parallel", "Insert", "Autograph", "Relic", "Other"],
    },
    subset: NULLABLE_STRING,
    parallel: NULLABLE_STRING,
    insert: NULLABLE_STRING,
    isRookie: { type: "BOOLEAN" },
    isAutograph: { type: "BOOLEAN" },
    isRelic: { type: "BOOLEAN" },
    serialNumber: NULLABLE_STRING,
    printRun: { type: "INTEGER", nullable: true },
    features: { type: "ARRAY", items: { type: "STRING" } },
    confidence: { type: "NUMBER" },
    uncertain: { type: "ARRAY", items: { type: "STRING" } },
    notes: NULLABLE_STRING,
  },
  required: ["isRookie", "isAutograph", "isRelic", "features", "confidence", "uncertain"],
};

const IDENTIFY_PROMPT = `You are a trading card identification expert specialising in football (soccer) cards, above all Panini and Topps.

You have been given the FRONT and the BACK of one single card. Use BOTH images. The back normally carries the card number, the set name, the copyright/licence line and the print run — read it closely.

Rules:
- Never invent a value you cannot actually see or reliably infer. Return null and add the field name to "uncertain".
- "serialNumber" is the stamped or hand-numbered form, e.g. "23/99". "printRun" is the denominator only, e.g. 99. A 1/1 has printRun 1.
- "features" holds anything notable that has no field of its own: refractor type, foil pattern, signature placement, patch colour, damage, print defect.
- "confidence" is 0 to 1 for the identification as a whole.
- If the images do not show a trading card, set confidence to 0 and say so in "notes".`;

export async function identifyCard(frontDataUrl, backDataUrl) {
  const text = await callGemini(MODEL_VISION, {
    contents: [{
      role: "user",
      parts: [
        { text: "FRONT of the card:" },
        { inline_data: { mime_type: "image/jpeg", data: dataUrlToBase64(frontDataUrl) } },
        { text: "BACK of the card:" },
        { inline_data: { mime_type: "image/jpeg", data: dataUrlToBase64(backDataUrl) } },
        { text: IDENTIFY_PROMPT },
      ],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseSchema: CARD_SCHEMA,
      // Reading fields off a card is extraction, not reasoning, and thinking
      // would eat the output budget for little gain. Raise this to 1024 if
      // identification accuracy disappoints on busy parallel designs.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return JSON.parse(text);
}

/* ------------------------------------------------------------------- value */

function valuePrompt(card, currency) {
  const parts = [
    card.season, card.manufacturer, card.set, card.parallel, card.insert,
    card.player, card.cardNumber ? `#${card.cardNumber}` : null,
    card.serialNumber ? `serial ${card.serialNumber}` : null,
    card.isRookie ? "rookie" : null,
    card.isAutograph ? "autograph" : null,
    card.isRelic ? "relic/patch" : null,
  ].filter(Boolean).join(" ");

  const grade = card.gradingCompany && card.gradingCompany !== "Raw / Ungraded"
    ? `${card.gradingCompany} ${card.grade || "(grade unknown)"}`
    : `raw / ungraded, condition ${card.condition}`;

  return `Find the current market value of this football trading card from recent SOLD listings.

Card: ${parts}
Condition: ${grade}

Search eBay sold/completed listings and any other source that reports actual realised sale prices. Prefer sales from the last 90 days and match the grade or condition as closely as you can.

Reply with ONLY a JSON object, no markdown fences, no commentary:

{
  "currency": "USD" or "EUR",
  "low": number or null,
  "average": number or null,
  "high": number or null,
  "salesCount": number,
  "insufficientData": true or false,
  "asOf": "YYYY-MM-DD",
  "sources": [{"label": "...", "url": "..."}],
  "comment": "..."
}

Rules that matter more than giving an answer:
- Every number must come from a sale price you actually observed in a search result. Do not estimate, do not interpolate from a similar player, set or year, do not use your own prior knowledge of card prices.
- If you find fewer than 3 genuine sold comparables for this exact card in this condition, set "insufficientData" to true, leave low/average/high as null, and put the reason in "comment".
- "salesCount" is the number of real sold listings you saw, not an estimate of market volume.
- Report in ${currency} if the sales are in that currency, otherwise report the currency the sales were actually in.`;
}

export async function estimateValue(card, currency) {
  const text = await callGemini(MODEL_SEARCH, {
    contents: [{ role: "user", parts: [{ text: valuePrompt(card, currency) }] }],
    // Grounding cannot be combined with responseSchema, so the reply is free
    // text and the JSON is dug out of it.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 2048 },
  });
  const v = extractJson(text);
  return { ...v, updatedAt: new Date().toISOString() };
}
