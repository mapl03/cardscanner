import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Camera, Home, Layers, Heart, User, Search, Plus, Trash2, Pencil, X, Check,
  ChevronRight, ArrowLeft, TrendingUp, TrendingDown, Download, RefreshCw,
  Loader2, AlertTriangle, ScanLine, Package, Copy, Trophy, Wallet, Star, Tag,
  Award, Filter, Upload, LogOut, Image as ImageIcon
} from "lucide-react";
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from "firebase/auth";

import { auth, configOk } from "./firebase";
import {
  setUid, subscribe, saveCard, deleteCard, saveWishlistItem, deleteWishlistItem,
  saveSettings, saveSets, saveHistory, restore, saveImages, loadImages,
  imagesAsDataUrls, EMPTY_DATA,
} from "./storage";
import { identifyCard, estimateValue, proxyConfigured } from "./ai";

/* ============================================================================
   CARD VAULT — football trading card scanner & catalogue

   Layers:
     firebase.js  project config, fails loudly when unconfigured
     storage.js   Firestore + Firebase Storage; the only file that persists
     ai.js        calls your Cloudflare Worker, which holds the API key
     App.jsx      this file: model, screens, app shell

   Manufacturer, card type, condition and filter lists are data at the top of
   this file. Adding Futera, another sport or another grader is a data change.
============================================================================ */

/* ---------------------------------------------------------------- constants */

const MANUFACTURERS = ["Panini", "Topps", "Futera", "Upper Deck", "Other"];
const CARD_TYPES = ["Base", "Parallel", "Insert", "Autograph", "Relic", "Other"];
const CONDITIONS = ["Poor", "Good", "Very Good", "Excellent", "Near Mint", "Mint"];
const GRADERS = ["Raw / Ungraded", "PSA", "BGS", "CGC", "SGC"];
const FILTER_CHIPS = [
  { key: "Panini", test: (c) => c.manufacturer === "Panini" },
  { key: "Topps", test: (c) => c.manufacturer === "Topps" },
  { key: "Rookie", test: (c) => c.isRookie },
  { key: "Autograph", test: (c) => c.isAutograph || c.cardType === "Autograph" },
  { key: "Relic", test: (c) => c.isRelic || c.cardType === "Relic" },
  { key: "Parallel", test: (c) => c.cardType === "Parallel" || !!c.parallel },
  { key: "Serial", test: (c) => !!c.serialNumber || !!c.printRun },
  { key: "PSA", test: (c) => c.gradingCompany === "PSA" },
  { key: "BGS", test: (c) => c.gradingCompany === "BGS" },
  { key: "Raw", test: (c) => !c.gradingCompany || c.gradingCompany === "Raw / Ungraded" },
];

const blankCard = () => ({
  id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  createdAt: new Date().toISOString(),
  player: "", club: "", nationalTeam: "",
  manufacturer: "", set: "", season: "", cardNumber: "",
  cardType: "", subset: "", parallel: "", insert: "",
  isRookie: false, isAutograph: false, isRelic: false,
  serialNumber: "", printRun: null, features: [],
  condition: "Near Mint", gradingCompany: "Raw / Ungraded", grade: "",
  purchasePrice: null, purchaseCurrency: "EUR", purchaseDate: "",
  notes: "", status: "owned",
  soldPrice: null, soldDate: "",
  value: null,
  thumbFront: null, thumbBack: null, hasFullImages: false,
  confidence: null, uncertain: [],
});

/* ------------------------------------------------------------------ imaging */

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Draw a source (img or video) to canvas, optional crop rect, enhance, export JPEG. */
function render(source, { crop, maxSide, quality, enhance }) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const c = crop
    ? { x: crop.x * sw, y: crop.y * sh, w: crop.w * sw, h: crop.h * sh }
    : { x: 0, y: 0, w: sw, h: sh };

  const scale = Math.min(1, maxSide / Math.max(c.w, c.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(c.w * scale);
  canvas.height = Math.round(c.h * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (enhance) ctx.filter = "contrast(1.09) saturate(1.07) brightness(1.03)";
  ctx.drawImage(source, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

const FULL = { maxSide: 1400, quality: 0.88, enhance: true };
const THUMB = { maxSide: 400, quality: 0.62, enhance: false };

function dataUrlToBase64(dataUrl) {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/* -------------------------------------------------------------------- model */

function convert(amount, from, settings) {
  if (amount == null || isNaN(amount)) return null;
  const to = settings.currency;
  if (!from || from === to) return amount;
  if (from === "USD" && to === "EUR") return amount * settings.usdEur;
  if (from === "EUR" && to === "USD") return amount / settings.usdEur;
  return amount;
}

function cardValue(card, settings) {
  if (!card.value || card.value.insufficientData) return null;
  const v = card.value.average ?? card.value.low ?? card.value.high;
  return convert(v, card.value.currency, settings);
}

function cardCost(card, settings) {
  return convert(card.purchasePrice, card.purchaseCurrency, settings);
}

function money(n, settings, opts = {}) {
  if (n == null || isNaN(n)) return "—";
  const cur = settings.currency;
  return new Intl.NumberFormat(cur === "EUR" ? "de-DE" : "en-US", {
    style: "currency",
    currency: cur,
    maximumFractionDigits: opts.round ? 0 : 2,
    minimumFractionDigits: opts.round ? 0 : 2,
  }).format(n);
}

function computeStats(data) {
  const s = data.settings;
  const active = data.cards.filter((c) => c.status !== "sold");
  const soldCards = data.cards.filter((c) => c.status === "sold");
  const totalValue = active.reduce((a, c) => a + (cardValue(c, s) || 0), 0);
  // Only cards still held count as invested — a sold card's cost belongs to realised P/L.
  const invested = active.reduce((a, c) => a + (cardCost(c, s) || 0), 0);
  const realised = soldCards.reduce(
    (a, c) => a + ((convert(c.soldPrice, c.purchaseCurrency, s) || 0) - (cardCost(c, s) || 0)), 0);
  const valued = active.filter((c) => cardValue(c, s) != null);

  const byPlayer = {};
  const byClub = {};
  for (const c of active) {
    if (c.player) {
      byPlayer[c.player] = byPlayer[c.player] || { n: 0, v: 0 };
      byPlayer[c.player].n += 1;
      byPlayer[c.player].v += cardValue(c, s) || 0;
    }
    if (c.club) byClub[c.club] = (byClub[c.club] || 0) + 1;
  }
  const top = (obj, pick) => {
    const e = Object.entries(obj);
    if (!e.length) return null;
    return e.sort((a, b) => pick(b[1]) - pick(a[1]))[0];
  };

  const mostValuable = valued.length
    ? valued.reduce((a, c) => (cardValue(c, s) > cardValue(a, s) ? c : a))
    : null;
  const priciestPlayer = top(byPlayer, (x) => x.v);
  const commonPlayer = top(byPlayer, (x) => x.n);
  const commonClub = top(byClub, (x) => x);

  return {
    count: active.length,
    sold: soldCards.length,
    unvalued: active.length - valued.length,
    totalValue, invested, realised,
    pl: totalValue - invested,
    plPct: invested > 0 ? ((totalValue - invested) / invested) * 100 : null,
    mostValuable,
    priciestPlayer: priciestPlayer ? { name: priciestPlayer[0], v: priciestPlayer[1].v } : null,
    commonPlayer: commonPlayer ? { name: commonPlayer[0], n: commonPlayer[1].n } : null,
    commonClub: commonClub ? { name: commonClub[0], n: commonClub[1] } : null,
  };
}

// History is always recorded in EUR. Recording it in the display currency
// would rewrite past points every time the user flips EUR/USD.
function withSnapshot(data) {
  const today = new Date().toISOString().slice(0, 10);
  const inEur = { ...data, settings: { ...data.settings, currency: "EUR" } };
  const total = computeStats(inEur).totalValue;
  const history = data.history.filter((h) => h.d !== today);
  history.push({ d: today, v: Math.round(total * 100) / 100 });
  return { ...data, history: history.slice(-365) };
}

function cardTitle(c) {
  return c.player || "Unidentified card";
}
function cardSubtitle(c) {
  return [c.set, c.season, c.cardNumber ? `#${c.cardNumber}` : null].filter(Boolean).join(" · ") || "No set data";
}

/* --------------------------------------------------------------------- css */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');

.cv{
  --ink:#0B0D14; --surf:#151824; --surf2:#1E2231; --line:#272C3D;
  --text:#EEF1F7; --muted:#7C859C; --dim:#4E566B;
  --holo1:#5EE9D5; --holo2:#8B7BF7; --gold:#E8B84B;
  --up:#34D399; --down:#F87171;
  --display:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;
  --body:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;
  position:relative; width:100%; max-width:480px; margin:0 auto; min-height:100vh;
  background:var(--ink); color:var(--text); font-family:var(--body);
  -webkit-font-smoothing:antialiased; overflow-x:hidden;
}
.cv *{box-sizing:border-box;}
.cv button{font-family:inherit;color:inherit;background:none;border:none;cursor:pointer;}
.cv input,.cv select,.cv textarea{font-family:inherit;}
.cv h1,.cv h2,.cv h3,.cv .num{font-family:var(--display);letter-spacing:-0.02em;}
.cv :focus-visible{outline:2px solid var(--holo1);outline-offset:2px;border-radius:8px;}

.cv-scroll{padding:20px 18px 116px;}
.cv-eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);font-weight:600;}
.cv-h1{font-size:26px;font-weight:700;margin:2px 0 0;}
.cv-h2{font-size:15px;font-weight:600;margin:0;}
.cv-muted{color:var(--muted);font-size:13px;}
.cv-tiny{color:var(--dim);font-size:11px;}

.cv-card{background:var(--surf);border:1px solid var(--line);border-radius:18px;}
.cv-row{display:flex;align-items:center;gap:12px;}
.cv-between{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.cv-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.cv-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}

/* signature: refractor sheen */
.holo{position:relative;overflow:hidden;}
.holo::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(105deg,transparent 30%,rgba(94,233,213,.16) 44%,rgba(139,123,247,.20) 52%,transparent 66%);
  transform:translateX(-120%);animation:sheen 5.5s ease-in-out infinite;
}
@keyframes sheen{0%,72%{transform:translateX(-120%)}100%{transform:translateX(120%)}}
@media (prefers-reduced-motion:reduce){.holo::after{animation:none;opacity:.35;transform:none;}}

.cv-hero{padding:18px;border-radius:22px;border:1px solid var(--line);
  background:radial-gradient(120% 140% at 12% 0%,#1D2334 0%,#12151F 55%,#0E111A 100%);}
.cv-value{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.05;}
.cv-delta{font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:4px;}

.cv-scanbtn{width:100%;padding:17px;border-radius:18px;font-family:var(--display);
  font-size:16px;font-weight:700;letter-spacing:.04em;color:#07131A;
  background:linear-gradient(100deg,var(--holo1),#7FE3E0 46%,var(--holo2));
  display:flex;align-items:center;justify-content:center;gap:10px;
  box-shadow:0 10px 34px -12px rgba(94,233,213,.65);transition:transform .16s ease;}
.cv-scanbtn:active{transform:scale(.98);}

.cv-tile{padding:13px 14px;border-radius:15px;background:var(--surf);border:1px solid var(--line);}
.cv-tile .n{font-family:var(--display);font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:3px;}

.cv-thumb{aspect-ratio:5/7;border-radius:11px;background:var(--surf2);object-fit:cover;width:100%;display:block;}
.cv-thumb-ph{aspect-ratio:5/7;border-radius:11px;background:linear-gradient(160deg,#1E2231,#171B27);
  display:flex;align-items:center;justify-content:center;color:var(--dim);}

.cv-chip{padding:6px 11px;border-radius:999px;border:1px solid var(--line);background:var(--surf);
  font-size:12px;font-weight:500;color:var(--muted);white-space:nowrap;transition:all .15s;}
.cv-chip.on{background:rgba(94,233,213,.13);border-color:rgba(94,233,213,.45);color:var(--holo1);}
.cv-chips{display:flex;gap:7px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none;}
.cv-chips::-webkit-scrollbar{display:none;}

.cv-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;
  font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;}
.cv-b-gold{background:rgba(232,184,75,.14);color:var(--gold);}
.cv-b-holo{background:rgba(94,233,213,.13);color:var(--holo1);}
.cv-b-vio{background:rgba(139,123,247,.15);color:#B4A8FF;}
.cv-b-dim{background:var(--surf2);color:var(--muted);}

.cv-input,.cv-select,.cv-area{
  width:100%;padding:11px 13px;border-radius:12px;background:var(--surf2);
  border:1px solid var(--line);color:var(--text);font-size:14px;outline:none;transition:border-color .15s;}
.cv-input:focus,.cv-select:focus,.cv-area:focus{border-color:var(--holo1);}
.cv-input::placeholder{color:var(--dim);}
.cv-label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);font-weight:600;
  display:block;margin-bottom:5px;}
.cv-select{appearance:none;}
.cv-select option{background:#1E2231;color:#EEF1F7;}

.cv-btn{padding:12px 16px;border-radius:13px;font-size:14px;font-weight:600;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:opacity .15s;}
.cv-btn:disabled{opacity:.45;cursor:not-allowed;}
.cv-btn-p{background:var(--holo1);color:#07131A;}
.cv-btn-s{background:var(--surf2);border:1px solid var(--line);color:var(--text);}
.cv-btn-d{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3);color:var(--down);}

.cv-nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;
  background:rgba(11,13,20,.93);backdrop-filter:blur(18px);border-top:1px solid var(--line);
  display:grid;grid-template-columns:repeat(5,1fr);align-items:end;padding:9px 6px calc(9px + env(safe-area-inset-bottom));z-index:40;}
.cv-navb{display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--dim);
  font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;padding:5px 0;}
.cv-navb.on{color:var(--holo1);}
.cv-navscan{margin-top:-24px;}
.cv-navscan .ring{width:53px;height:53px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,var(--holo1),var(--holo2));color:#07131A;
  box-shadow:0 8px 26px -8px rgba(94,233,213,.7);border:3px solid var(--ink);}

.cv-sheet{position:fixed;inset:0;z-index:60;background:rgba(6,8,13,.75);backdrop-filter:blur(6px);
  display:flex;align-items:flex-end;justify-content:center;animation:fade .18s ease;}
.cv-sheet-in{width:100%;max-width:480px;max-height:92vh;overflow-y:auto;background:var(--ink);
  border-top:1px solid var(--line);border-radius:24px 24px 0 0;padding:16px 18px calc(26px + env(safe-area-inset-bottom));
  animation:rise .24s cubic-bezier(.2,.8,.3,1);}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{transform:translateY(22px);opacity:0}to{transform:translateY(0);opacity:1}}
.cv-handle{width:36px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 14px;}

.cv-cam{position:fixed;inset:0;z-index:70;background:#000;display:flex;flex-direction:column;}
.cv-camview{flex:1;position:relative;overflow:hidden;}
.cv-camview video{width:100%;height:100%;object-fit:cover;}
.cv-guide{position:absolute;border:2px solid rgba(94,233,213,.9);border-radius:14px;
  box-shadow:0 0 0 9999px rgba(0,0,0,.55);}
.cv-guide span{position:absolute;top:-26px;left:0;font-size:11px;font-weight:600;letter-spacing:.1em;
  text-transform:uppercase;color:var(--holo1);}

.cv-prog{height:4px;border-radius:2px;background:var(--surf2);overflow:hidden;}
.cv-prog i{display:block;height:100%;background:linear-gradient(90deg,var(--holo1),var(--holo2));border-radius:2px;}

.cv-spin{animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
.cv-fadein{animation:fade .3s ease;}
.cv-warn{background:rgba(232,184,75,.09);border:1px solid rgba(232,184,75,.28);border-radius:13px;padding:12px 13px;
  color:#F0CE84;font-size:12.5px;line-height:1.5;}
`;

/* ---------------------------------------------------------------- utilities */

function Field({ label, children }) {
  return <div><label className="cv-label">{label}</label>{children}</div>;
}

function Tile({ label, value, tone }) {
  return (
    <div className="cv-tile">
      <div className="cv-eyebrow">{label}</div>
      <div className="n" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

function Badges({ card }) {
  const b = [];
  if (card.isRookie) b.push(["RC", "cv-b-gold"]);
  if (card.isAutograph || card.cardType === "Autograph") b.push(["Auto", "cv-b-vio"]);
  if (card.isRelic || card.cardType === "Relic") b.push(["Relic", "cv-b-vio"]);
  if (card.serialNumber) b.push([card.serialNumber, "cv-b-holo"]);
  else if (card.printRun) b.push([`/${card.printRun}`, "cv-b-holo"]);
  if (card.gradingCompany && card.gradingCompany !== "Raw / Ungraded")
    b.push([`${card.gradingCompany} ${card.grade || ""}`.trim(), "cv-b-gold"]);
  if (card.status === "forSale") b.push(["For sale", "cv-b-dim"]);
  if (card.status === "sold") b.push(["Sold", "cv-b-dim"]);
  if (!b.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
      {b.map(([t, cls], i) => <span key={i} className={`cv-badge ${cls}`}>{t}</span>)}
    </div>
  );
}

function Thumb({ src, alt }) {
  if (!src) return <div className="cv-thumb-ph"><ImageIcon size={20} /></div>;
  return <img className="cv-thumb" src={src} alt={alt || ""} />;
}

/* ----------------------------------------------------------------- camera */

const GUIDE = { x: 0.115, y: 0.185, w: 0.77, h: 0.63 };

function CameraCapture({ label, onCapture, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const [live, setLive] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        setLive(true);
      } catch (e) {
        setErr("Camera unavailable here. Take the photo with your phone's camera instead.");
      }
    })();
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const shoot = () => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    // Guide box is in CSS pixels of a cover-fitted video — map it back to source pixels.
    const vw = v.videoWidth, vh = v.videoHeight;
    const bw = v.clientWidth, bh = v.clientHeight;
    const scale = Math.max(bw / vw, bh / vh);
    const shownW = vw * scale, shownH = vh * scale;
    const offX = (shownW - bw) / 2, offY = (shownH - bh) / 2;
    const crop = {
      x: (offX + GUIDE.x * bw) / shownW,
      y: (offY + GUIDE.y * bh) / shownH,
      w: (GUIDE.w * bw) / shownW,
      h: (GUIDE.h * bh) / shownH,
    };
    onCapture({
      full: render(v, { crop, ...FULL }),
      thumb: render(v, { crop, ...THUMB }),
    });
  };

  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const img = await fileToImage(f);
    onCapture({ full: render(img, FULL), thumb: render(img, THUMB) });
  };

  return (
    <div className="cv-cam">
      <div className="cv-between" style={{ padding: "14px 16px" }}>
        <button onClick={onCancel} aria-label="Cancel"><X size={22} color="#EEF1F7" /></button>
        <div style={{ fontFamily: "var(--display)", fontWeight: 700, letterSpacing: ".08em", fontSize: 13, color: "#EEF1F7" }}>
          {label}
        </div>
        <div style={{ width: 22 }} />
      </div>

      <div className="cv-camview">
        <video ref={videoRef} playsInline muted autoPlay />
        {live && (
          <div className="cv-guide" style={{
            left: `${GUIDE.x * 100}%`, top: `${GUIDE.y * 100}%`,
            width: `${GUIDE.w * 100}%`, height: `${GUIDE.h * 100}%`,
          }}>
            <span>Fill the frame</span>
          </div>
        )}
        {err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
            justifyContent: "center", padding: 30, textAlign: "center", color: "#7C859C", fontSize: 14 }}>
            {err}
          </div>
        )}
      </div>

      <div style={{ padding: "20px 18px calc(28px + env(safe-area-inset-bottom))", display: "flex",
        flexDirection: "column", alignItems: "center", gap: 14 }}>
        {live && (
          <button onClick={shoot} aria-label="Take photo" style={{
            width: 68, height: 68, borderRadius: "50%", background: "#EEF1F7",
            border: "4px solid rgba(255,255,255,.25)",
          }} />
        )}
        <input ref={fileRef} type="file" accept="image/*" capture="environment"
          onChange={pick} style={{ display: "none" }} />
        <button className="cv-btn cv-btn-s" onClick={() => fileRef.current && fileRef.current.click()}>
          <Upload size={15} /> {live ? "Use a photo instead" : "Choose a photo"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- scan screen */

function ScanScreen({ data, onSave, onExit }) {
  const [step, setStep] = useState("front");   // front | back | analysing | review
  const [shots, setShots] = useState({});
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState(null);
  const [valuing, setValuing] = useState(false);

  const analyse = async (front, back) => {
    setStep("analysing");
    setErr(null);
    try {
      const id = await identifyCard(front.full, back.full);
      const shape = blankCard();
      const card = {
        ...shape,
        ...Object.fromEntries(Object.entries(id).filter(([k]) => k in shape)),
        features: Array.isArray(id.features) ? id.features : [],
        uncertain: Array.isArray(id.uncertain) ? id.uncertain : [],
        confidence: typeof id.confidence === "number" ? id.confidence : null,
        purchaseCurrency: data.settings.currency,
        thumbFront: front.thumb, thumbBack: back.thumb, hasFullImages: true,
      };
      setDraft(card);
      setStep("review");
      runValue(card);
    } catch (e) {
      setErr("Identification failed. You can still fill the card in by hand.");
      setDraft({
        ...blankCard(), thumbFront: front.thumb, thumbBack: back.thumb,
        hasFullImages: true, purchaseCurrency: data.settings.currency,
      });
      setStep("review");
    }
  };

  const runValue = async (card) => {
    if (!card.player && !card.set) return;
    setValuing(true);
    try {
      const v = await estimateValue(card, data.settings.currency);
      setDraft((d) => (d ? { ...d, value: v } : d));
    } catch (e) {
      setDraft((d) => (d ? { ...d, value: { insufficientData: true, comment: "Price lookup failed.", salesCount: 0 } } : d));
    }
    setValuing(false);
  };

  const capture = (which) => (shot) => {
    const next = { ...shots, [which]: shot };
    setShots(next);
    if (which === "front") setStep("back");
    else analyse(next.front, next.back);
  };

  if (step === "front" || step === "back") {
    return (
      <CameraCapture
        label={step === "front" ? "Step 1 · Scan front" : "Step 2 · Scan back"}
        onCapture={capture(step)}
        onCancel={onExit}
      />
    );
  }

  if (step === "analysing") {
    return (
      <div className="cv-scroll" style={{ display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", minHeight: "80vh", gap: 20 }}>
        <div className="holo" style={{ width: 130, borderRadius: 12 }}>
          <Thumb src={shots.front && shots.front.thumb} alt="Scanned card" />
        </div>
        <div style={{ textAlign: "center" }}>
          <Loader2 className="cv-spin" size={22} color="#5EE9D5" />
          <div className="cv-h2" style={{ marginTop: 10 }}>Reading the card</div>
          <div className="cv-muted" style={{ marginTop: 4 }}>Front and back, player, set, serial.</div>
        </div>
      </div>
    );
  }

  return (
    <ReviewScreen
      card={draft}
      shots={shots}
      settings={data.settings}
      valuing={valuing}
      error={err}
      onRevalue={runValue}
      onCancel={onExit}
      onSave={(c) => onSave(c, shots)}
    />
  );
}

/* ----------------------------------------------------- scan result / review */

function ValueBlock({ card, settings, valuing, onRevalue }) {
  const v = card.value;
  if (valuing) {
    return (
      <div className="cv-card" style={{ padding: 16 }}>
        <div className="cv-row"><Loader2 className="cv-spin" size={16} color="#5EE9D5" />
          <span className="cv-muted">Searching recent sold listings…</span></div>
      </div>
    );
  }
  if (!v) {
    return (
      <button className="cv-btn cv-btn-s" style={{ width: "100%" }} onClick={() => onRevalue(card)}>
        <RefreshCw size={15} /> Look up market value
      </button>
    );
  }
  if (v.insufficientData) {
    return (
      <div className="cv-warn">
        <div className="cv-row" style={{ alignItems: "flex-start" }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>Insufficient market data to provide a reliable value.</strong>
            {v.comment ? <div style={{ marginTop: 5, opacity: .85 }}>{v.comment}</div> : null}
          </div>
        </div>
        <button className="cv-btn cv-btn-s" style={{ width: "100%", marginTop: 11 }} onClick={() => onRevalue(card)}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }
  const disp = (n) => money(convert(n, v.currency, settings), settings);
  return (
    <div className="cv-hero holo">
      <div className="cv-eyebrow">Estimated value</div>
      <div className="cv-value" style={{ marginTop: 4 }}>{disp(v.average)}</div>
      <div className="cv-grid3" style={{ marginTop: 15 }}>
        <div><div className="cv-eyebrow">Low</div><div className="num" style={{ fontSize: 14, marginTop: 3 }}>{disp(v.low)}</div></div>
        <div><div className="cv-eyebrow">Avg</div><div className="num" style={{ fontSize: 14, marginTop: 3 }}>{disp(v.average)}</div></div>
        <div><div className="cv-eyebrow">High</div><div className="num" style={{ fontSize: 14, marginTop: 3 }}>{disp(v.high)}</div></div>
      </div>
      <div className="cv-between" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <span className="cv-tiny">{v.salesCount || 0} comparable sales · {v.asOf || "today"}</span>
        <button onClick={() => onRevalue(card)} className="cv-tiny" style={{ color: "#5EE9D5" }}>Refresh</button>
      </div>
      {Array.isArray(v.sources) && v.sources.length > 0 && (
        <div style={{ marginTop: 9, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {v.sources.slice(0, 3).map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noreferrer" className="cv-badge cv-b-dim"
              style={{ textDecoration: "none" }}>{s.label}</a>
          ))}
        </div>
      )}
    </div>
  );
}

function CardForm({ card, onChange }) {
  const set = (k) => (e) => onChange({ ...card, [k]: e.target.value });
  const setNum = (k) => (e) => onChange({ ...card, [k]: e.target.value === "" ? null : Number(e.target.value) });
  const toggle = (k) => () => onChange({ ...card, [k]: !card[k] });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="Player"><input className="cv-input" value={card.player || ""} onChange={set("player")} placeholder="e.g. Lionel Messi" /></Field>
      <div className="cv-grid2">
        <Field label="Club"><input className="cv-input" value={card.club || ""} onChange={set("club")} placeholder="Inter Miami" /></Field>
        <Field label="National team"><input className="cv-input" value={card.nationalTeam || ""} onChange={set("nationalTeam")} placeholder="Argentina" /></Field>
      </div>
      <div className="cv-grid2">
        <Field label="Manufacturer">
          <select className="cv-select" value={card.manufacturer || ""} onChange={set("manufacturer")}>
            <option value="">—</option>
            {MANUFACTURERS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="Season"><input className="cv-input" value={card.season || ""} onChange={set("season")} placeholder="2024-25" /></Field>
      </div>
      <Field label="Set"><input className="cv-input" value={card.set || ""} onChange={set("set")} placeholder="Topps Chrome UEFA" /></Field>
      <div className="cv-grid2">
        <Field label="Card number"><input className="cv-input" value={card.cardNumber || ""} onChange={set("cardNumber")} placeholder="123" /></Field>
        <Field label="Card type">
          <select className="cv-select" value={card.cardType || ""} onChange={set("cardType")}>
            <option value="">—</option>
            {CARD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <div className="cv-grid2">
        <Field label="Parallel"><input className="cv-input" value={card.parallel || ""} onChange={set("parallel")} placeholder="Gold Refractor" /></Field>
        <Field label="Insert / subset"><input className="cv-input" value={card.insert || card.subset || ""} onChange={set("insert")} placeholder="Future Stars" /></Field>
      </div>
      <div className="cv-grid2">
        <Field label="Serial number"><input className="cv-input" value={card.serialNumber || ""} onChange={set("serialNumber")} placeholder="23/99" /></Field>
        <Field label="Print run"><input className="cv-input" type="number" value={card.printRun ?? ""} onChange={setNum("printRun")} placeholder="99" /></Field>
      </div>

      <div className="cv-chips" style={{ marginTop: 2 }}>
        {[["isRookie", "Rookie"], ["isAutograph", "Autograph"], ["isRelic", "Relic"]].map(([k, l]) => (
          <button key={k} className={`cv-chip ${card[k] ? "on" : ""}`} onClick={toggle(k)}>{l}</button>
        ))}
      </div>

      <div className="cv-grid2">
        <Field label="Condition">
          <select className="cv-select" value={card.condition || ""} onChange={set("condition")}>
            {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Grading">
          <select className="cv-select" value={card.gradingCompany || ""} onChange={set("gradingCompany")}>
            {GRADERS.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>
      </div>
      {card.gradingCompany && card.gradingCompany !== "Raw / Ungraded" && (
        <Field label="Grade"><input className="cv-input" value={card.grade || ""} onChange={set("grade")} placeholder="10" /></Field>
      )}

      <div className="cv-grid2">
        <Field label="Purchase price">
          <input className="cv-input" type="number" step="0.01" value={card.purchasePrice ?? ""}
            onChange={setNum("purchasePrice")} placeholder="0.00" />
        </Field>
        <Field label="Purchase date">
          <input className="cv-input" type="date" value={card.purchaseDate || ""} onChange={set("purchaseDate")} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea className="cv-area" rows={3} value={card.notes || ""} onChange={set("notes")}
          placeholder="Corner wear, pulled from a UEFA blaster, trade history…" />
      </Field>
    </div>
  );
}

function ReviewScreen({ card, shots, settings, valuing, error, onRevalue, onSave, onCancel }) {
  const [draft, setDraft] = useState(card);
  const [edit, setEdit] = useState(false);
  useEffect(() => { setDraft((d) => ({ ...card, ...d, value: card.value })); }, [card.value]);

  const lowConf = draft.confidence != null && draft.confidence < 0.6;

  return (
    <div className="cv-scroll cv-fadein">
      <div className="cv-between" style={{ marginBottom: 16 }}>
        <button onClick={onCancel} className="cv-row" style={{ color: "var(--muted)", fontSize: 13 }}>
          <ArrowLeft size={17} /> Discard
        </button>
        <button className="cv-btn cv-btn-p" style={{ padding: "9px 18px" }} onClick={() => onSave(draft)}>
          <Check size={16} /> Save to collection
        </button>
      </div>

      <div className="cv-grid2" style={{ marginBottom: 16 }}>
        <div className="holo" style={{ borderRadius: 11 }}><Thumb src={draft.thumbFront} alt="Card front" /></div>
        <Thumb src={draft.thumbBack} alt="Card back" />
      </div>

      <div className="cv-eyebrow">Identified</div>
      <h1 className="cv-h1">{cardTitle(draft)}</h1>
      <div className="cv-muted" style={{ marginTop: 3 }}>{cardSubtitle(draft)}</div>
      <Badges card={draft} />

      {error && <div className="cv-warn" style={{ marginTop: 14 }}>{error}</div>}
      {!error && lowConf && (
        <div className="cv-warn" style={{ marginTop: 14 }}>
          Low confidence read{draft.uncertain && draft.uncertain.length ? ` — unsure about: ${draft.uncertain.join(", ")}.` : "."} Check the fields before saving.
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <ValueBlock card={draft} settings={settings} valuing={valuing} onRevalue={onRevalue} />
      </div>

      <div className="cv-between" style={{ margin: "22px 0 12px" }}>
        <h2 className="cv-h2">Card details</h2>
        <button onClick={() => setEdit(!edit)} className="cv-row" style={{ color: "#5EE9D5", fontSize: 13 }}>
          <Pencil size={14} /> {edit ? "Done" : "Correct"}
        </button>
      </div>

      {edit ? (
        <CardForm card={draft} onChange={setDraft} />
      ) : (
        <div className="cv-card" style={{ padding: 4 }}>
          {[
            ["Player", draft.player], ["Club", draft.club], ["National team", draft.nationalTeam],
            ["Manufacturer", draft.manufacturer], ["Set", draft.set], ["Season", draft.season],
            ["Card number", draft.cardNumber && `#${draft.cardNumber}`], ["Card type", draft.cardType],
            ["Parallel", draft.parallel], ["Insert", draft.insert],
            ["Serial number", draft.serialNumber || (draft.printRun ? `/${draft.printRun}` : null)],
            ["Condition", draft.condition],
            ["Grading", draft.gradingCompany !== "Raw / Ungraded" ? `${draft.gradingCompany} ${draft.grade || ""}`.trim() : "Raw / Ungraded"],
          ].map(([k, v]) => (
            <div key={k} className="cv-between" style={{ padding: "11px 13px", borderBottom: "1px solid var(--line)" }}>
              <span className="cv-tiny">{k}</span>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: v ? "var(--text)" : "var(--dim)", textAlign: "right" }}>
                {v || "Not identified"}
              </span>
            </div>
          ))}
          {draft.features && draft.features.length > 0 && (
            <div style={{ padding: "11px 13px" }}>
              <div className="cv-tiny" style={{ marginBottom: 6 }}>Features</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {draft.features.map((f, i) => <span key={i} className="cv-badge cv-b-dim">{f}</span>)}
              </div>
            </div>
          )}
        </div>
      )}

      <button className="cv-btn cv-btn-p" style={{ width: "100%", marginTop: 20 }} onClick={() => onSave(draft)}>
        <Check size={17} /> Save to collection
      </button>
    </div>
  );
}


/** Collection value over time. A single polyline — not worth a chart library. */
function ValueChart({ points, format }) {
  const [hover, setHover] = useState(null);
  const W = 320, H = 150, PAD = { l: 8, r: 8, t: 12, b: 20 };

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi === lo) { hi = lo + 1; lo = Math.max(0, lo - 1); }   // flat line sits mid-height
    const pad = (hi - lo) * 0.12;
    lo = Math.max(0, lo - pad); hi = hi + pad;
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    const xy = points.map((p, i) => [
      PAD.l + (i / (points.length - 1)) * iw,
      PAD.t + ih - ((p.v - lo) / (hi - lo)) * ih,
    ]);
    return { xy, lo, hi, ih };
  }, [points]);

  if (!geom) {
    return (
      <div style={{ padding: "26px 12px", textAlign: "center" }} className="cv-muted">
        The chart fills in as the collection value is recorded each day.
      </div>
    );
  }

  const { xy, ih } = geom;
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${PAD.t + ih} L${xy[0][0].toFixed(1)},${PAD.t + ih} Z`;
  const at = hover != null ? points[hover] : points[points.length - 1];

  const track = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    xy.forEach(([px], i) => { if (Math.abs(px - x) < Math.abs(xy[best][0] - x)) best = i; });
    setHover(best);
  };

  return (
    <div>
      <div className="cv-between" style={{ padding: "0 6px 8px" }}>
        <span className="num" style={{ fontSize: 18 }}>{format(at.v)}</span>
        <span className="cv-tiny">{at.d}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label="Collection value over time"
        onMouseMove={track} onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => track(e.touches[0])} onTouchMove={(e) => track(e.touches[0])}
        onTouchEnd={() => setHover(null)}>
        <defs>
          <linearGradient id="cvFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5EE9D5" stopOpacity="0.24" />
            <stop offset="100%" stopColor="#5EE9D5" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#cvFill)" />
        <path d={line} fill="none" stroke="#5EE9D5" strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <>
            <line x1={xy[hover][0]} y1={PAD.t} x2={xy[hover][0]} y2={PAD.t + ih}
              stroke="#272C3D" strokeWidth="1" />
            <circle cx={xy[hover][0]} cy={xy[hover][1]} r="4" fill="#0B0D14"
              stroke="#5EE9D5" strokeWidth="2" />
          </>
        )}
        <text x={PAD.l} y={H - 5} fill="#4E566B" fontSize="9">{points[0].d}</text>
        <text x={W - PAD.r} y={H - 5} fill="#4E566B" fontSize="9" textAnchor="end">
          {points[points.length - 1].d}
        </text>
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------- home screen */

function HomeScreen({ data, stats, onScan, onOpenCard, onTab }) {
  const s = data.settings;
  const [q, setQ] = useState("");
  const recent = useMemo(
    () => [...data.cards].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 6),
    [data.cards]
  );
  const hits = useMemo(() => {
    if (!q.trim()) return [];
    const t = q.toLowerCase();
    return data.cards.filter((c) =>
      [c.player, c.club, c.set, c.season, c.cardNumber, c.manufacturer]
        .filter(Boolean).join(" ").toLowerCase().includes(t)
    ).slice(0, 8);
  }, [q, data.cards]);

  return (
    <div className="cv-scroll cv-fadein">
      <div className="cv-eyebrow">Card Vault</div>
      <h1 className="cv-h1" style={{ marginBottom: 16 }}>Your collection</h1>

      <div className="cv-hero holo">
        <div className="cv-eyebrow">Estimated collection value</div>
        <div className="cv-value" style={{ marginTop: 5 }}>{money(stats.totalValue, s, { round: true })}</div>
        <div className="cv-row" style={{ marginTop: 9, gap: 14 }}>
          <span className="cv-muted">{stats.count} cards</span>
          {stats.plPct != null && (
            <span className="cv-delta" style={{ color: stats.pl >= 0 ? "var(--up)" : "var(--down)" }}>
              {stats.pl >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              {stats.pl >= 0 ? "+" : ""}{money(stats.pl, s, { round: true })} ({stats.plPct.toFixed(1)}%)
            </span>
          )}
        </div>
        {stats.unvalued > 0 && (
          <div className="cv-tiny" style={{ marginTop: 9 }}>{stats.unvalued} card{stats.unvalued > 1 ? "s" : ""} without market data</div>
        )}
      </div>

      <button className="cv-scanbtn holo" style={{ marginTop: 16 }} onClick={onScan}>
        <ScanLine size={19} /> SCAN CARD
      </button>

      <div style={{ position: "relative", marginTop: 16 }}>
        <Search size={16} color="#4E566B" style={{ position: "absolute", left: 13, top: 13 }} />
        <input className="cv-input" style={{ paddingLeft: 38 }} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search player, club, set…" />
      </div>

      {hits.length > 0 && (
        <div className="cv-card" style={{ marginTop: 10, padding: 4 }}>
          {hits.map((c) => (
            <button key={c.id} onClick={() => onOpenCard(c.id)} className="cv-between"
              style={{ width: "100%", padding: "10px 11px", textAlign: "left" }}>
              <div className="cv-row">
                <div style={{ width: 32 }}><Thumb src={c.thumbFront} /></div>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{cardTitle(c)}</div>
                  <div className="cv-tiny">{cardSubtitle(c)}</div>
                </div>
              </div>
              <ChevronRight size={15} color="#4E566B" />
            </button>
          ))}
        </div>
      )}

      {stats.mostValuable && (
        <>
          <div className="cv-eyebrow" style={{ marginTop: 24, marginBottom: 9 }}>Most valuable card</div>
          <button className="cv-card cv-row" style={{ width: "100%", padding: 13, textAlign: "left" }}
            onClick={() => onOpenCard(stats.mostValuable.id)}>
            <div style={{ width: 56, flexShrink: 0 }} className="holo">
              <Thumb src={stats.mostValuable.thumbFront} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{cardTitle(stats.mostValuable)}</div>
              <div className="cv-tiny" style={{ marginTop: 2 }}>{cardSubtitle(stats.mostValuable)}</div>
              <div className="num" style={{ fontSize: 17, color: "var(--gold)", marginTop: 6 }}>
                {money(cardValue(stats.mostValuable, s), s)}
              </div>
            </div>
          </button>
        </>
      )}

      <div className="cv-between" style={{ marginTop: 24, marginBottom: 9 }}>
        <div className="cv-eyebrow">Recently added</div>
        <button className="cv-tiny" style={{ color: "#5EE9D5" }} onClick={() => onTab("collection")}>
          View collection
        </button>
      </div>

      {recent.length === 0 ? (
        <div className="cv-card" style={{ padding: 26, textAlign: "center" }}>
          <Package size={26} color="#4E566B" />
          <div className="cv-h2" style={{ marginTop: 11 }}>No cards yet</div>
          <div className="cv-muted" style={{ marginTop: 5 }}>Scan your first card to start the catalogue.</div>
        </div>
      ) : (
        <div className="cv-grid3">
          {recent.map((c) => (
            <button key={c.id} onClick={() => onOpenCard(c.id)} style={{ textAlign: "left" }}>
              <Thumb src={c.thumbFront} alt={cardTitle(c)} />
              <div style={{ fontSize: 11.5, fontWeight: 600, marginTop: 6, whiteSpace: "nowrap",
                overflow: "hidden", textOverflow: "ellipsis" }}>{cardTitle(c)}</div>
              <div className="cv-tiny">{cardValue(c, s) != null ? money(cardValue(c, s), s, { round: true }) : "No data"}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- collection screen */

function CollectionScreen({ data, onOpenCard, onManual, onEditSet }) {
  const s = data.settings;
  const [view, setView] = useState("cards");
  const [q, setQ] = useState("");
  const [active, setActive] = useState([]);
  const [sort, setSort] = useState("recent");
  const [editingSet, setEditingSet] = useState(null);
  const [sizeInput, setSizeInput] = useState("");

  const toggle = (k) => setActive((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

  const shown = useMemo(() => {
    let list = data.cards;
    if (q.trim()) {
      const t = q.toLowerCase();
      list = list.filter((c) =>
        [c.player, c.club, c.set, c.season, c.cardNumber, c.manufacturer, c.cardType, c.parallel]
          .filter(Boolean).join(" ").toLowerCase().includes(t));
    }
    for (const k of active) {
      const chip = FILTER_CHIPS.find((f) => f.key === k);
      if (chip) list = list.filter(chip.test);
    }
    const by = {
      recent: (a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""),
      value: (a, b) => (cardValue(b, s) || 0) - (cardValue(a, s) || 0),
      player: (a, b) => (a.player || "zz").localeCompare(b.player || "zz"),
    };
    return [...list].sort(by[sort]);
  }, [data.cards, q, active, sort, s]);

  const sets = useMemo(() => {
    const map = {};
    for (const c of data.cards) {
      if (!c.set) continue;
      const key = [c.set, c.season].filter(Boolean).join(" ");
      map[key] = map[key] || { key, numbers: [], cards: 0 };
      map[key].cards += 1;
      const n = parseInt(c.cardNumber, 10);
      if (!isNaN(n)) map[key].numbers.push(n);
    }
    return Object.values(map).sort((a, b) => b.cards - a.cards);
  }, [data.cards]);

  return (
    <div className="cv-scroll cv-fadein">
      <div className="cv-between" style={{ marginBottom: 14 }}>
        <div>
          <div className="cv-eyebrow">Collection</div>
          <h1 className="cv-h1">{data.cards.length} cards</h1>
        </div>
        <button className="cv-btn cv-btn-s" style={{ padding: "9px 13px" }} onClick={onManual}>
          <Plus size={15} /> Add
        </button>
      </div>

      <div className="cv-chips" style={{ marginBottom: 13 }}>
        <button className={`cv-chip ${view === "cards" ? "on" : ""}`} onClick={() => setView("cards")}>Cards</button>
        <button className={`cv-chip ${view === "sets" ? "on" : ""}`} onClick={() => setView("sets")}>Set checklists</button>
      </div>

      {view === "sets" ? (
        sets.length === 0 ? (
          <div className="cv-card" style={{ padding: 26, textAlign: "center" }}>
            <Layers size={24} color="#4E566B" />
            <div className="cv-h2" style={{ marginTop: 11 }}>No sets identified yet</div>
            <div className="cv-muted" style={{ marginTop: 5 }}>Checklists appear once cards carry a set name.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {sets.map((st) => {
              const total = (data.sets[st.key] && data.sets[st.key].total) || null;
              const owned = new Set(st.numbers);
              const missing = total ? Array.from({ length: total }, (_, i) => i + 1).filter((n) => !owned.has(n)) : [];
              const pct = total ? Math.min(100, (owned.size / total) * 100) : 0;
              return (
                <div key={st.key} className="cv-card" style={{ padding: 14 }}>
                  <div className="cv-between">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{st.key}</div>
                      <div className="num" style={{ fontSize: 13, color: "var(--holo1)", marginTop: 3 }}>
                        {owned.size} / {total || "?"} collected
                      </div>
                    </div>
                    <button className="cv-tiny" style={{ color: "#5EE9D5" }}
                      onClick={() => { setEditingSet(editingSet === st.key ? null : st.key); setSizeInput(total || ""); }}>
                      {editingSet === st.key ? "Cancel" : "Set size"}
                    </button>
                  </div>
                  {editingSet === st.key && (
                    <div className="cv-row" style={{ gap: 8, marginTop: 11 }}>
                      <input className="cv-input" type="number" value={sizeInput} autoFocus
                        onChange={(e) => setSizeInput(e.target.value)}
                        placeholder="Cards in the full set, e.g. 200" />
                      <button className="cv-btn cv-btn-p" style={{ padding: "11px 15px" }}
                        onClick={() => { onEditSet(st.key, parseInt(sizeInput, 10)); setEditingSet(null); }}>
                        <Check size={15} />
                      </button>
                    </div>
                  )}
                  {total && (
                    <>
                      <div className="cv-prog" style={{ marginTop: 11 }}><i style={{ width: `${pct}%` }} /></div>
                      {missing.length > 0 && (
                        <div style={{ marginTop: 11 }}>
                          <div className="cv-tiny" style={{ marginBottom: 6 }}>Missing ({missing.length})</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {missing.slice(0, 40).map((n) => <span key={n} className="cv-badge cv-b-dim">#{n}</span>)}
                            {missing.length > 40 && <span className="cv-tiny">+{missing.length - 40} more</span>}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )
      ) : (
        <>
          <div style={{ position: "relative", marginBottom: 11 }}>
            <Search size={16} color="#4E566B" style={{ position: "absolute", left: 13, top: 13 }} />
            <input className="cv-input" style={{ paddingLeft: 38 }} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Player, club, set, number…" />
          </div>

          <div className="cv-chips" style={{ marginBottom: 11 }}>
            {FILTER_CHIPS.map((f) => (
              <button key={f.key} className={`cv-chip ${active.includes(f.key) ? "on" : ""}`}
                onClick={() => toggle(f.key)}>{f.key}</button>
            ))}
          </div>

          <div className="cv-between" style={{ marginBottom: 12 }}>
            <span className="cv-tiny">{shown.length} shown</span>
            <div className="cv-row" style={{ gap: 6 }}>
              <Filter size={12} color="#4E566B" />
              <select className="cv-select" style={{ width: "auto", padding: "5px 9px", fontSize: 12 }}
                value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="recent">Newest</option>
                <option value="value">Value</option>
                <option value="player">Player A–Z</option>
              </select>
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="cv-card" style={{ padding: 26, textAlign: "center" }}>
              <div className="cv-h2">Nothing matches</div>
              <div className="cv-muted" style={{ marginTop: 5 }}>Clear a filter or widen the search.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {shown.map((c) => {
                const val = cardValue(c, s);
                const cost = cardCost(c, s);
                const pl = val != null && cost != null ? val - cost : null;
                return (
                  <button key={c.id} onClick={() => onOpenCard(c.id)} className="cv-card cv-row"
                    style={{ padding: 11, textAlign: "left", opacity: c.status === "sold" ? .55 : 1 }}>
                    <div style={{ width: 50, flexShrink: 0 }}><Thumb src={c.thumbFront} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden",
                        textOverflow: "ellipsis" }}>{cardTitle(c)}</div>
                      <div className="cv-tiny" style={{ marginTop: 2, whiteSpace: "nowrap", overflow: "hidden",
                        textOverflow: "ellipsis" }}>{cardSubtitle(c)}</div>
                      <Badges card={c} />
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div className="num" style={{ fontSize: 14.5, fontWeight: 700 }}>
                        {val != null ? money(val, s, { round: true }) : "—"}
                      </div>
                      {pl != null && (
                        <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2,
                          color: pl >= 0 ? "var(--up)" : "var(--down)" }}>
                          {pl >= 0 ? "+" : ""}{money(pl, s, { round: true })}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- card detail */

function CardDetail({ card, settings, onClose, onUpdate, onDelete, onDuplicate }) {
  const [draft, setDraft] = useState(card);
  const [edit, setEdit] = useState(false);
  const [full, setFull] = useState(null);
  const [valuing, setValuing] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    let live = true;
    if (card.hasFullImages) loadImages(card.id).then((i) => { if (live) setFull(i); });
    return () => { live = false; };
  }, [card.id]);

  const revalue = async (c) => {
    setValuing(true);
    try {
      const v = await estimateValue(c, settings.currency);
      const next = { ...draft, value: v };
      setDraft(next); onUpdate(next);
    } catch (e) {
      const next = { ...draft, value: { insufficientData: true, comment: "Price lookup failed.", salesCount: 0 } };
      setDraft(next); onUpdate(next);
    }
    setValuing(false);
  };

  const setStatus = (status) => { const n = { ...draft, status }; setDraft(n); onUpdate(n); };

  const val = cardValue(draft, settings);
  const cost = cardCost(draft, settings);
  const pl = val != null && cost != null ? val - cost : null;

  return (
    <div className="cv-sheet" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cv-sheet-in">
        <div className="cv-handle" />
        <div className="cv-between" style={{ marginBottom: 14 }}>
          <button onClick={onClose} className="cv-row" style={{ color: "var(--muted)", fontSize: 13 }}>
            <X size={17} /> Close
          </button>
          <div className="cv-row" style={{ gap: 14 }}>
            <button onClick={() => onDuplicate(draft)} className="cv-tiny" style={{ color: "#5EE9D5" }}>Duplicate</button>
            <button onClick={() => { setEdit(!edit); if (edit) onUpdate(draft); }} className="cv-row"
              style={{ color: "#5EE9D5", fontSize: 13 }}>
              <Pencil size={14} /> {edit ? "Save" : "Edit"}
            </button>
          </div>
        </div>

        <div className="cv-grid2" style={{ marginBottom: 16 }}>
          <div className="holo" style={{ borderRadius: 11 }}>
            <Thumb src={(full && full.front) || draft.thumbFront} alt="Card front" />
          </div>
          <Thumb src={(full && full.back) || draft.thumbBack} alt="Card back" />
        </div>

        <h1 className="cv-h1">{cardTitle(draft)}</h1>
        <div className="cv-muted" style={{ marginTop: 3 }}>{cardSubtitle(draft)}</div>
        <Badges card={draft} />

        <div style={{ marginTop: 16 }}>
          <ValueBlock card={draft} settings={settings} valuing={valuing} onRevalue={revalue} />
        </div>

        <div className="cv-grid3" style={{ marginTop: 12 }}>
          <Tile label="Paid" value={cost != null ? money(cost, settings, { round: true }) : "—"} />
          <Tile label="Now" value={val != null ? money(val, settings, { round: true }) : "—"} />
          <Tile label="P/L" tone={pl == null ? undefined : pl >= 0 ? "var(--up)" : "var(--down)"}
            value={pl != null ? `${pl >= 0 ? "+" : ""}${money(pl, settings, { round: true })}` : "—"} />
        </div>

        <div className="cv-chips" style={{ marginTop: 14 }}>
          {[["owned", "In collection"], ["forSale", "For sale"], ["sold", "Sold"]].map(([k, l]) => (
            <button key={k} className={`cv-chip ${draft.status === k ? "on" : ""}`} onClick={() => setStatus(k)}>{l}</button>
          ))}
        </div>

        {draft.status === "sold" && (
          <div className="cv-card" style={{ padding: 13, marginTop: 12 }}>
            <div className="cv-grid2">
              <Field label="Sold for">
                <input className="cv-input" type="number" step="0.01" value={draft.soldPrice ?? ""}
                  onChange={(e) => {
                    const n = { ...draft, soldPrice: e.target.value === "" ? null : Number(e.target.value) };
                    setDraft(n); onUpdate(n);
                  }} placeholder="0.00" />
              </Field>
              <Field label="Sold on">
                <input className="cv-input" type="date" value={draft.soldDate || ""}
                  onChange={(e) => { const n = { ...draft, soldDate: e.target.value }; setDraft(n); onUpdate(n); }} />
              </Field>
            </div>
            {draft.soldPrice != null && cost != null && (
              <div className="cv-between" style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--line)" }}>
                <span className="cv-tiny">Realised profit / loss</span>
                <span className="num" style={{ fontSize: 15,
                  color: draft.soldPrice - cost >= 0 ? "var(--up)" : "var(--down)" }}>
                  {draft.soldPrice - cost >= 0 ? "+" : ""}{money(draft.soldPrice - cost, settings)}
                </span>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          {edit ? (
            <CardForm card={draft} onChange={setDraft} />
          ) : (
            <>
              {draft.purchaseDate && (
                <div className="cv-between" style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                  <span className="cv-tiny">Purchase date</span>
                  <span style={{ fontSize: 13.5 }}>{draft.purchaseDate}</span>
                </div>
              )}
              {draft.notes && (
                <div style={{ marginTop: 14 }}>
                  <div className="cv-eyebrow" style={{ marginBottom: 6 }}>Notes</div>
                  <div className="cv-muted" style={{ lineHeight: 1.55 }}>{draft.notes}</div>
                </div>
              )}
            </>
          )}
        </div>

        {edit && (
          <button className="cv-btn cv-btn-p" style={{ width: "100%", marginTop: 18 }}
            onClick={() => { onUpdate(draft); setEdit(false); }}>
            <Check size={16} /> Save changes
          </button>
        )}

        {confirm ? (
          <div className="cv-warn" style={{ marginTop: 16 }}>
            Delete this card and its photos permanently?
            <div className="cv-row" style={{ marginTop: 11, gap: 8 }}>
              <button className="cv-btn cv-btn-d" style={{ flex: 1 }} onClick={() => onDelete(draft.id)}>Delete</button>
              <button className="cv-btn cv-btn-s" style={{ flex: 1 }} onClick={() => setConfirm(false)}>Keep</button>
            </div>
          </div>
        ) : (
          <button className="cv-btn cv-btn-d" style={{ width: "100%", marginTop: 16 }} onClick={() => setConfirm(true)}>
            <Trash2 size={15} /> Delete card
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- wishlist screen */

function WishlistScreen({ data, onAdd, onRemove, onValue }) {
  const s = data.settings;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ player: "", set: "", season: "", cardNumber: "", note: "" });
  const [busy, setBusy] = useState(null);

  const add = () => {
    if (!draft.player.trim() && !draft.set.trim()) return;
    onAdd({ ...draft, id: `w_${Date.now().toString(36)}`, value: null, addedAt: new Date().toISOString() });
    setDraft({ player: "", set: "", season: "", cardNumber: "", note: "" });
    setOpen(false);
  };

  const lookup = async (item) => {
    setBusy(item.id);
    try {
      const v = await estimateValue({ ...blankCard(), ...item, condition: "Near Mint" }, s.currency);
      onValue(item.id, v);
    } catch (e) {
      onValue(item.id, { insufficientData: true, comment: "Price lookup failed.", salesCount: 0 });
    }
    setBusy(null);
  };

  return (
    <div className="cv-scroll cv-fadein">
      <div className="cv-between" style={{ marginBottom: 16 }}>
        <div>
          <div className="cv-eyebrow">Wishlist</div>
          <h1 className="cv-h1">{data.wishlist.length} chased</h1>
        </div>
        <button className="cv-btn cv-btn-s" style={{ padding: "9px 13px" }} onClick={() => setOpen(!open)}>
          <Plus size={15} /> Add
        </button>
      </div>

      {open && (
        <div className="cv-card" style={{ padding: 14, marginBottom: 16, display: "flex", flexDirection: "column", gap: 11 }}>
          <Field label="Player"><input className="cv-input" value={draft.player}
            onChange={(e) => setDraft({ ...draft, player: e.target.value })} placeholder="Jude Bellingham" /></Field>
          <Field label="Set"><input className="cv-input" value={draft.set}
            onChange={(e) => setDraft({ ...draft, set: e.target.value })} placeholder="Panini Prizm UEFA" /></Field>
          <div className="cv-grid2">
            <Field label="Season"><input className="cv-input" value={draft.season}
              onChange={(e) => setDraft({ ...draft, season: e.target.value })} placeholder="2024-25" /></Field>
            <Field label="Number"><input className="cv-input" value={draft.cardNumber}
              onChange={(e) => setDraft({ ...draft, cardNumber: e.target.value })} placeholder="12" /></Field>
          </div>
          <button className="cv-btn cv-btn-p" onClick={add}>Add to wishlist</button>
        </div>
      )}

      {data.wishlist.length === 0 ? (
        <div className="cv-card" style={{ padding: 26, textAlign: "center" }}>
          <Heart size={24} color="#4E566B" />
          <div className="cv-h2" style={{ marginTop: 11 }}>Nothing on the wishlist</div>
          <div className="cv-muted" style={{ marginTop: 5 }}>Add the cards you are hunting and track what they sell for.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {data.wishlist.map((w) => {
            const v = w.value;
            const price = v && !v.insufficientData ? convert(v.average, v.currency, s) : null;
            return (
              <div key={w.id} className="cv-card" style={{ padding: 13 }}>
                <div className="cv-between">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{w.player || "Card"}</div>
                    <div className="cv-tiny" style={{ marginTop: 2 }}>
                      {[w.set, w.season, w.cardNumber ? `#${w.cardNumber}` : null].filter(Boolean).join(" · ") || "No set data"}
                    </div>
                  </div>
                  <button onClick={() => onRemove(w.id)} aria-label="Remove"><Trash2 size={15} color="#4E566B" /></button>
                </div>
                <div className="cv-between" style={{ marginTop: 11, paddingTop: 11, borderTop: "1px solid var(--line)" }}>
                  {price != null ? (
                    <div>
                      <div className="cv-eyebrow">Last known market</div>
                      <div className="num" style={{ fontSize: 16, marginTop: 2 }}>{money(price, s)}</div>
                      <div className="cv-tiny" style={{ marginTop: 2 }}>{v.salesCount || 0} sales · {v.asOf || ""}</div>
                    </div>
                  ) : (
                    <span className="cv-tiny">{v && v.insufficientData ? "Insufficient market data" : "No price yet"}</span>
                  )}
                  <button className="cv-btn cv-btn-s" style={{ padding: "8px 12px", fontSize: 12.5 }}
                    disabled={busy === w.id} onClick={() => lookup(w)}>
                    {busy === w.id ? <Loader2 size={13} className="cv-spin" /> : <RefreshCw size={13} />}
                    {busy === w.id ? "Checking" : "Check price"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- profile screen */

function ProfileScreen({ data, stats, email, onSettings, onExport, onImport, onSignOut }) {
  const s = data.settings;
  const [showBackup, setShowBackup] = useState(false);
  const [payload, setPayload] = useState("");
  const chart = useMemo(
    () => [...data.history].sort((a, b) => a.d.localeCompare(b.d)).map((h) => ({ d: h.d.slice(5), v: h.v })),
    [data.history]
  );

  return (
    <div className="cv-scroll cv-fadein">
      <div className="cv-eyebrow">Profile</div>
      <h1 className="cv-h1">Collection stats</h1>
      <div className="cv-muted" style={{ marginTop: 3, marginBottom: 16 }}>{email}</div>

      <div className="cv-grid2" style={{ marginBottom: 10 }}>
        <Tile label="Total cards" value={stats.count} />
        <Tile label="Total value" value={money(stats.totalValue, s, { round: true })} />
        <Tile label="Invested" value={money(stats.invested, s, { round: true })} />
        <Tile label="Profit / loss"
          tone={stats.pl >= 0 ? "var(--up)" : "var(--down)"}
          value={`${stats.pl >= 0 ? "+" : ""}${money(stats.pl, s, { round: true })}`} />
      </div>

      <div className="cv-card" style={{ padding: 4, marginBottom: 16 }}>
        {[
          ["Most valuable card", stats.mostValuable ? `${cardTitle(stats.mostValuable)} · ${money(cardValue(stats.mostValuable, s), s, { round: true })}` : "—", Trophy],
          ["Most expensive player", stats.priciestPlayer ? `${stats.priciestPlayer.name} · ${money(stats.priciestPlayer.v, s, { round: true })}` : "—", Star],
          ["Most represented player", stats.commonPlayer ? `${stats.commonPlayer.name} · ${stats.commonPlayer.n} cards` : "—", Award],
          ["Most represented club", stats.commonClub ? `${stats.commonClub.name} · ${stats.commonClub.n} cards` : "—", Tag],
          ["Sold cards", stats.sold > 0
            ? `${stats.sold} · realised ${stats.realised >= 0 ? "+" : ""}${money(stats.realised, s, { round: true })}`
            : "0", Wallet],
        ].map(([k, v, Icon], i, arr) => (
          <div key={k} className="cv-between"
            style={{ padding: "12px 13px", borderBottom: i < arr.length - 1 ? "1px solid var(--line)" : "none" }}>
            <div className="cv-row" style={{ gap: 9 }}>
              <Icon size={14} color="#4E566B" />
              <span className="cv-tiny">{k}</span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 500, textAlign: "right", maxWidth: "58%" }}>{v}</span>
          </div>
        ))}
      </div>

      <div className="cv-eyebrow" style={{ marginBottom: 9 }}>Value over time · EUR</div>
      <div className="cv-card" style={{ padding: "16px 10px 8px", marginBottom: 20 }}>
        <ValueChart points={chart} format={(v) => money(v, { currency: "EUR" }, { round: true })} />
      </div>

      <div className="cv-eyebrow" style={{ marginBottom: 9 }}>Settings</div>
      <div className="cv-card" style={{ padding: 14, marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="cv-grid2">
          <Field label="Display currency">
            <select className="cv-select" value={s.currency}
              onChange={(e) => onSettings({ ...s, currency: e.target.value })}>
              <option value="EUR">EUR €</option>
              <option value="USD">USD $</option>
            </select>
          </Field>
          <Field label="USD → EUR rate">
            <input className="cv-input" type="number" step="0.01" value={s.usdEur}
              onChange={(e) => onSettings({ ...s, usdEur: Number(e.target.value) || 0.92 })} />
          </Field>
        </div>
        <div className="cv-tiny">Most card sales are quoted in USD. Set the rate you want conversions to use.</div>
      </div>

      <div className="cv-eyebrow" style={{ marginBottom: 9 }}>Data</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <button className="cv-btn cv-btn-s" onClick={onExport}><Download size={15} /> Export collection as CSV</button>
        <button className="cv-btn cv-btn-s" onClick={() => { setPayload(JSON.stringify(data)); setShowBackup(true); }}>
          <Copy size={15} /> Back up / restore
        </button>
        <button className="cv-btn cv-btn-s" onClick={onSignOut}><LogOut size={15} /> Sign out</button>
      </div>

      {showBackup && (
        <div className="cv-card" style={{ padding: 14, marginTop: 12 }}>
          <div className="cv-between" style={{ marginBottom: 10 }}>
            <span className="cv-h2">Backup</span>
            <button onClick={() => setShowBackup(false)}><X size={16} color="#7C859C" /></button>
          </div>
          <div className="cv-tiny" style={{ marginBottom: 8 }}>
            Copy this out to back up. Paste a backup in and restore to replace everything.
          </div>
          <textarea className="cv-area" rows={5} value={payload} onChange={(e) => setPayload(e.target.value)} />
          <div className="cv-row" style={{ gap: 8, marginTop: 10 }}>
            <button className="cv-btn cv-btn-s" style={{ flex: 1 }}
              onClick={() => navigator.clipboard && navigator.clipboard.writeText(payload)}>Copy</button>
            <button className="cv-btn cv-btn-p" style={{ flex: 1 }} onClick={() => onImport(payload)}>Restore</button>
          </div>
        </div>
      )}

      <div className="cv-tiny" style={{ marginTop: 24, lineHeight: 1.6 }}>
        Values come from recent sold listings found at the time of each lookup. They are an indication of the market,
        not an appraisal. Refresh a card before you trade on its number.
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- nav + app */

const TABS = [
  { key: "home", label: "Home", Icon: Home },
  { key: "collection", label: "Cards", Icon: Layers },
  { key: "scan", label: "Scan", Icon: Camera },
  { key: "wishlist", label: "Wishlist", Icon: Heart },
  { key: "profile", label: "Profile", Icon: User },
];

function BottomNav({ tab, onTab }) {
  return (
    <nav className="cv-nav">
      {TABS.map(({ key, label, Icon }) =>
        key === "scan" ? (
          <button key={key} className="cv-navb cv-navscan" onClick={() => onTab("scan")} aria-label="Scan a card">
            <div className="ring"><ScanLine size={23} /></div>
            <span style={{ color: tab === "scan" ? "var(--holo1)" : "var(--dim)" }}>Scan</span>
          </button>
        ) : (
          <button key={key} className={`cv-navb ${tab === key ? "on" : ""}`} onClick={() => onTab(key)}>
            <Icon size={19} />
            <span>{label}</span>
          </button>
        )
      )}
    </nav>
  );
}

/* ------------------------------------------------------------- setup gates */

function Blocker({ title, children }) {
  return (
    <div className="cv">
      <style>{CSS}</style>
      <div className="cv-scroll" style={{ paddingTop: 80 }}>
        <AlertTriangle size={28} color="#E8B84B" />
        <h1 className="cv-h1" style={{ marginTop: 14 }}>{title}</h1>
        <div className="cv-muted" style={{ marginTop: 10, lineHeight: 1.6 }}>{children}</div>
      </div>
    </div>
  );
}

function SignIn() {
  const [mode, setMode] = useState("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email.trim(), pw);
      else await createUserWithEmailAndPassword(auth, email.trim(), pw);
    } catch (e) {
      const map = {
        "auth/invalid-credential": "That email and password do not match an account.",
        "auth/invalid-email": "That does not look like an email address.",
        "auth/weak-password": "Pick a password of at least six characters.",
        "auth/email-already-in-use": "An account already exists for that email.",
        "auth/operation-not-allowed": "Email sign-in is switched off in the Firebase console.",
        "auth/network-request-failed": "No connection. Check the network and try again.",
      };
      setErr(map[e.code] || e.message);
    }
    setBusy(false);
  };

  return (
    <div className="cv">
      <style>{CSS}</style>
      <div className="cv-scroll" style={{ paddingTop: 70, paddingBottom: 40 }}>
        <div className="cv-eyebrow">Card Vault</div>
        <h1 className="cv-h1" style={{ marginBottom: 6 }}>
          {mode === "in" ? "Sign in" : "Create an account"}
        </h1>
        <div className="cv-muted" style={{ marginBottom: 26 }}>
          Your collection is private to your account and syncs to every device you sign in on.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label className="cv-label">Email</label>
            <input className="cv-input" type="email" autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div>
            <label className="cv-label">Password</label>
            <input className="cv-input" type="password" value={pw}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()} placeholder="••••••••" />
          </div>
        </div>

        {err && <div className="cv-warn" style={{ marginTop: 14 }}>{err}</div>}

        <button className="cv-btn cv-btn-p" style={{ width: "100%", marginTop: 20 }}
          disabled={busy || !email || !pw} onClick={go}>
          {busy ? <Loader2 size={16} className="cv-spin" /> : <Check size={16} />}
          {mode === "in" ? "Sign in" : "Create account"}
        </button>

        <button className="cv-tiny" style={{ color: "#5EE9D5", marginTop: 18, width: "100%" }}
          onClick={() => { setMode(mode === "in" ? "up" : "in"); setErr(null); }}>
          {mode === "in" ? "No account yet? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- shell */

export default function CardVault() {
  const [user, setUser] = useState(undefined);   // undefined = still checking
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("home");
  const [openId, setOpenId] = useState(null);
  const [manual, setManual] = useState(null);
  const [toast, setToast] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const lastHistory = useRef("");

  /* auth */
  useEffect(() => {
    if (!configOk) return undefined;
    return onAuthStateChanged(auth, (u) => {
      setUid(u ? u.uid : null);
      setUser(u);
      if (!u) { setData(null); lastHistory.current = ""; }
    });
  }, []);

  /* live data */
  useEffect(() => {
    if (!user) return undefined;
    setSyncError(null);
    return subscribe(setData, (e) => setSyncError(e.message));
  }, [user]);

  /* one collection-value point per day, recorded in EUR */
  useEffect(() => {
    if (!data || !data.ready) return;
    const next = withSnapshot(data).history;
    const sig = JSON.stringify(next);
    if (sig === JSON.stringify(data.history) || sig === lastHistory.current) return;
    lastHistory.current = sig;
    saveHistory(next);
  }, [data]);

  const stats = useMemo(() => (data ? computeStats(data) : null), [data]);
  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  const guard = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) { flash(e.message || "That did not save"); }
  };

  /* ------------------------------------------------------------ mutations */

  const saveScanned = guard(async (card, shots) => {
    if (shots && shots.front && shots.back) {
      const ok = await saveImages(card.id, shots.front.full, shots.back.full);
      card = { ...card, hasFullImages: ok };
    }
    await saveCard(card);
    setTab("collection");
    flash("Card saved");
  });

  const updateCard = guard(async (card) => { await saveCard(card); });

  const removeCard = guard(async (id) => {
    await deleteCard(id);
    setOpenId(null);
    flash("Card deleted");
  });

  const duplicateCard = guard(async (card) => {
    const copy = { ...card, id: blankCard().id, createdAt: new Date().toISOString(), hasFullImages: false };
    if (card.hasFullImages) {
      const imgs = await imagesAsDataUrls(card.id);
      if (imgs) copy.hasFullImages = await saveImages(copy.id, imgs.front, imgs.back);
    }
    await saveCard(copy);
    setOpenId(null);
    flash("Card duplicated");
  });

  const exportCsv = () => {
    const cols = ["player", "club", "nationalTeam", "manufacturer", "set", "season", "cardNumber",
      "cardType", "parallel", "insert", "serialNumber", "printRun", "isRookie", "isAutograph", "isRelic",
      "condition", "gradingCompany", "grade", "purchasePrice", "purchaseCurrency", "purchaseDate",
      "status", "soldPrice", "soldDate", "notes"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [...cols, "estimatedValue", "valueCurrency", "valueAsOf"].join(","),
      ...data.cards.map((c) => [
        ...cols.map((k) => esc(c[k])),
        esc(c.value && !c.value.insufficientData ? c.value.average : ""),
        esc(c.value ? c.value.currency : ""),
        esc(c.value ? c.value.asOf : ""),
      ].join(",")),
    ].join("\r\n");

    try {
      // BOM so Excel reads č/š/ž correctly instead of mangling them.
      const url = URL.createObjectURL(new Blob(["\uFEFF" + rows], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = "card-scanner.csv"; a.click();
      URL.revokeObjectURL(url);
      flash("CSV exported");
    } catch (e) {
      if (navigator.clipboard) navigator.clipboard.writeText(rows);
      flash("CSV copied to clipboard");
    }
  };

  const importBackup = guard(async (text) => {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cards)) throw new Error("That backup could not be read");
    await restore({ ...EMPTY_DATA, ...parsed });
    flash("Backup restored");
  });

  /* ---------------------------------------------------------------- gates */

  if (!configOk) {
    return (
      <Blocker title="Firebase is not configured">
        Open <code>src/firebase.js</code> and replace every <code>PASTE_…</code> value with the config
        from your Firebase console, under Project settings → Your apps → SDK setup and configuration.
        Nothing can be saved until that is done.
      </Blocker>
    );
  }

  if (user === undefined) {
    return (
      <div className="cv">
        <style>{CSS}</style>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <Loader2 className="cv-spin" size={24} color="#5EE9D5" />
        </div>
      </div>
    );
  }

  if (!user) return <SignIn />;

  if (!data || !data.ready) {
    return (
      <div className="cv">
        <style>{CSS}</style>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minHeight: "100vh", gap: 14 }}>
          <Loader2 className="cv-spin" size={24} color="#5EE9D5" />
          <span className="cv-muted">Loading your collection…</span>
          {syncError && <div className="cv-warn" style={{ margin: "0 24px" }}>{syncError}</div>}
        </div>
      </div>
    );
  }

  const openCard = data.cards.find((c) => c.id === openId) || null;

  return (
    <div className="cv">
      <style>{CSS}</style>

      {tab === "scan" ? (
        <ScanScreen data={data} onSave={saveScanned} onExit={() => setTab("home")} />
      ) : (
        <>
          {syncError && (
            <div className="cv-warn" style={{ margin: "14px 18px 0" }}>
              Sync problem: {syncError}. Changes stay on this device until it clears.
            </div>
          )}
          {!proxyConfigured && (
            <div className="cv-warn" style={{ margin: "14px 18px 0" }}>
              <code>VITE_API_PROXY</code> is not set, so scanning and price lookups are switched off.
              Deploy the Worker and put its URL in <code>.env</code>.
            </div>
          )}

          {tab === "home" && (
            <HomeScreen data={data} stats={stats} onScan={() => setTab("scan")}
              onOpenCard={setOpenId} onTab={setTab} />
          )}
          {tab === "collection" && (
            <CollectionScreen data={data} onOpenCard={setOpenId}
              onManual={() => setManual({ ...blankCard(), purchaseCurrency: data.settings.currency })}
              onEditSet={(key, n) => saveSets({ ...data.sets, [key]: { total: !n || isNaN(n) ? null : n } })} />
          )}
          {tab === "wishlist" && (
            <WishlistScreen data={data}
              onAdd={saveWishlistItem}
              onRemove={deleteWishlistItem}
              onValue={(id, v) => {
                const item = data.wishlist.find((w) => w.id === id);
                if (item) saveWishlistItem({ ...item, value: v });
              }} />
          )}
          {tab === "profile" && (
            <ProfileScreen data={data} stats={stats} email={user.email}
              onSettings={saveSettings} onExport={exportCsv} onImport={importBackup}
              onSignOut={() => signOut(auth)} />
          )}
          <BottomNav tab={tab} onTab={setTab} />
        </>
      )}

      {openCard && (
        <CardDetail card={openCard} settings={data.settings} onClose={() => setOpenId(null)}
          onUpdate={updateCard} onDelete={removeCard} onDuplicate={duplicateCard} />
      )}

      {manual && (
        <div className="cv-sheet" onClick={(e) => e.target === e.currentTarget && setManual(null)}>
          <div className="cv-sheet-in">
            <div className="cv-handle" />
            <div className="cv-between" style={{ marginBottom: 16 }}>
              <h2 className="cv-h2">Add a card by hand</h2>
              <button onClick={() => setManual(null)}><X size={18} color="#7C859C" /></button>
            </div>
            <CardForm card={manual} onChange={setManual} />
            <button className="cv-btn cv-btn-p" style={{ width: "100%", marginTop: 18 }}
              onClick={async () => { await updateCard(manual); setManual(null); flash("Card added"); }}>
              <Check size={16} /> Add to collection
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 96, left: "50%", transform: "translateX(-50%)", zIndex: 80,
          background: "#1E2231", border: "1px solid #272C3D", borderRadius: 12,
          padding: "10px 18px", fontSize: 13, fontWeight: 500, color: "#EEF1F7",
          maxWidth: "88%", textAlign: "center",
          boxShadow: "0 12px 32px -10px rgba(0,0,0,.6)",
        }}>{toast}</div>
      )}
    </div>
  );
}
