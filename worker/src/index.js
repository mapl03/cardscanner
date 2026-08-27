/* ============================================================================
   Card Vault API proxy.

   Holds the Gemini key and refuses every request that does not carry a valid
   Firebase ID token from your project. Without this, publishing the app means
   publishing your API key.

   Layers, in order:
     1. Origin allow-list  — only your GitHub Pages URL may call it
     2. Firebase ID token  — RS256 signature verified against Google's JWKS
     3. Daily per-user quota (optional, needs a KV binding)
     4. Request shape      — model allow-listed, output tokens capped, body size capped

   Deploy:
     cd worker
     npx wrangler secret put GEMINI_API_KEY
     npx wrangler deploy
============================================================================ */

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// The browser picks a model, but only from this list — otherwise a tampered
// request could point at an expensive model on your key.
const ALLOWED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
]);
const MAX_OUTPUT_TOKENS_CAP = 4096;
const MAX_BODY_BYTES = 6 * 1024 * 1024; // two full-size card scans, with room

/* ------------------------------------------------------------ jwt verifying */

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

let jwksCache = { keys: null, fetchedAt: 0 };

async function getJwks() {
  const age = Date.now() - jwksCache.fetchedAt;
  if (jwksCache.keys && age < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error("Could not fetch Google signing keys");
  const body = await res.json();
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/**
 * Verify a Firebase ID token and return its payload.
 * Throws on any failure — never return a partially checked token.
 */
async function verifyIdToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = b64urlToJson(rawHeader);
  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");

  const jwks = await getJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!ok) throw new Error("Bad token signature");

  const p = b64urlToJson(rawPayload);
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== projectId) throw new Error("Token issued for another project");
  if (p.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Bad issuer");
  if (!p.sub) throw new Error("Token has no subject");
  if (p.exp <= now) throw new Error("Token expired");
  if (p.iat > now + 300) throw new Error("Token issued in the future");
  return p;
}

/* ----------------------------------------------------------------- quota */

/** Returns { allowed, used, limit }. Without a KV binding, quota is skipped. */
async function checkQuota(env, uid) {
  const limit = parseInt(env.DAILY_LIMIT || "0", 10);
  if (!env.QUOTA || !limit) return { allowed: true, used: 0, limit: 0 };

  const day = new Date().toISOString().slice(0, 10);
  const key = `q:${uid}:${day}`;
  const used = parseInt((await env.QUOTA.get(key)) || "0", 10);
  if (used >= limit) return { allowed: false, used, limit };

  // Two days of TTL so a call just before midnight cannot lose its counter.
  await env.QUOTA.put(key, String(used + 1), { expirationTtl: 172800 });
  return { allowed: true, used: used + 1, limit };
}

/* ------------------------------------------------------------------ router */

function corsHeaders(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowList = (env.ALLOWED_ORIGINS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const originOk = allowList.length === 0 || allowList.includes(origin);
    const cors = corsHeaders(origin, originOk);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!originOk) return json({ error: "Origin not allowed" }, 403, cors);

    if (!env.GEMINI_API_KEY) return json({ error: "Worker is missing GEMINI_API_KEY" }, 500, cors);
    if (!env.FIREBASE_PROJECT_ID) return json({ error: "Worker is missing FIREBASE_PROJECT_ID" }, 500, cors);

    const authHeader = request.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401, cors);

    let claims;
    try {
      claims = await verifyIdToken(authHeader.slice(7), env.FIREBASE_PROJECT_ID);
    } catch (e) {
      return json({ error: `Rejected: ${e.message}` }, 401, cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413, cors);

    let body;
    try { body = JSON.parse(raw); }
    catch { return json({ error: "Body is not valid JSON" }, 400, cors); }

    const { model, ...payload } = body;
    if (!ALLOWED_MODELS.has(model)) return json({ error: "Model not allowed" }, 400, cors);

    payload.generationConfig = payload.generationConfig || {};
    payload.generationConfig.maxOutputTokens = Math.min(
      payload.generationConfig.maxOutputTokens || 2048, MAX_OUTPUT_TOKENS_CAP);

    const quota = await checkQuota(env, claims.sub);
    if (!quota.allowed) {
      return json({ error: `Daily limit of ${quota.limit} lookups reached. Resets at midnight UTC.` }, 429, cors);
    }

    const upstream = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  },
};
