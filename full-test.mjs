/* Renders the whole app in jsdom against fixture data, with the Firebase and
   AI layers mocked out (see test-mocks/). No network, no credentials.

     npm run test
*/
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";

const value = (avg) => ({ currency: "EUR", low: avg*0.8, average: avg, high: avg*1.2,
  salesCount: 6, insufficientData: false, asOf: "2026-08-20", sources: [{label:"eBay",url:"https://ebay.com"}] });

const DATA = {
  ready: true,
  settings: { currency: "EUR", usdEur: 0.92 },
  sets: { "Topps Chrome UEFA 2025": { total: 200 } },
  history: [
    { d: "2026-08-24", v: 300 }, { d: "2026-08-25", v: 340 },
    { d: "2026-08-26", v: 335 }, { d: "2026-08-27", v: 410 },
  ],
  wishlist: [
    { id: "w1", player: "Jude Bellingham", set: "Panini Prizm UEFA", season: "2024-25", addedAt: "2026-08-01", value: value(55) },
    { id: "w2", player: "Lamine Yamal", set: "Topps Chrome", addedAt: "2026-07-01", value: { insufficientData: true, comment: "Only one sale found.", salesCount: 1 } },
  ],
  cards: [
    { id:"c1", createdAt:"2026-08-26", player:"Lionel Messi", club:"Inter Miami", nationalTeam:"Argentina",
      manufacturer:"Topps", set:"Topps Chrome UEFA", season:"2025", cardNumber:"123", cardType:"Parallel",
      parallel:"Gold Refractor", insert:"", subset:"", isRookie:false, isAutograph:true, isRelic:false,
      serialNumber:"23/50", printRun:50, features:["Gold refractor","On-card auto"],
      condition:"Near Mint", gradingCompany:"PSA", grade:"10", purchasePrice:120, purchaseCurrency:"EUR",
      purchaseDate:"2026-01-15", notes:"Pulled from a UEFA blaster.", status:"owned",
      soldPrice:null, soldDate:"", value:value(300), thumbFront:null, thumbBack:null,
      hasFullImages:false, confidence:0.92, uncertain:[] },
    { id:"c2", createdAt:"2026-08-25", player:"Erling Haaland", club:"Man City", manufacturer:"Panini",
      set:"Panini Prizm UEFA", season:"2024-25", cardNumber:"7", cardType:"Base", isRookie:true,
      isAutograph:false, isRelic:false, serialNumber:"", printRun:null, features:[],
      condition:"Mint", gradingCompany:"Raw / Ungraded", grade:"", purchasePrice:8,
      purchaseCurrency:"EUR", purchaseDate:"2026-03-02", notes:"", status:"owned",
      soldPrice:null, soldDate:"", value:value(110), thumbFront:null, thumbBack:null,
      hasFullImages:false, confidence:0.4, uncertain:["parallel"] },
    { id:"c3", createdAt:"2026-08-20", player:"Kylian Mbappe", club:"Real Madrid", manufacturer:"Topps",
      set:"Topps Chrome UEFA", season:"2025", cardNumber:"45", cardType:"Base", isRookie:false,
      isAutograph:false, isRelic:false, serialNumber:"", printRun:null, features:[],
      condition:"Excellent", gradingCompany:"Raw / Ungraded", grade:"", purchasePrice:50,
      purchaseCurrency:"EUR", purchaseDate:"2026-02-01", notes:"", status:"sold",
      soldPrice:80, soldDate:"2026-08-20", value:value(75), thumbFront:null, thumbBack:null,
      hasFullImages:false, confidence:0.8, uncertain:[] },
    { id:"c4", createdAt:"2026-08-18", player:"", club:"", manufacturer:"", set:"", season:"",
      cardNumber:"", cardType:"", isRookie:false, isAutograph:false, isRelic:false, serialNumber:"",
      printRun:null, features:[], condition:"Good", gradingCompany:"Raw / Ungraded", grade:"",
      purchasePrice:null, purchaseCurrency:"EUR", purchaseDate:"", notes:"", status:"owned",
      soldPrice:null, soldDate:"", value:null, thumbFront:null, thumbBack:null,
      hasFullImages:false, confidence:0, uncertain:["everything"] },
  ],
};

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => { const m=String(e.detail||e.message); if(!m.includes("fonts.googleapis.com")) errors.push("jsdomError: "+m); });
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
  runScripts: "dangerously", url: "https://example.github.io/card-vault/",
  pretendToBeVisual: true, virtualConsole: vc,
});
const { window } = dom;
window.__USER__ = { uid: "u1", email: "matic@example.com", getIdToken: async () => "t" };
window.__DATA__ = DATA;
window.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
window.scrollTo = () => {};
window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage(){}, });
const s = window.document.createElement("script");
s.textContent = fs.readFileSync("./test-build.js", "utf8");
window.document.body.appendChild(s);
await new Promise((r) => setTimeout(r, 900));

const doc = window.document;
const copy = () => doc.getElementById("root").textContent.split("}").pop();
const click = async (label) => {
  const b = [...doc.querySelectorAll("button")].find((x) => x.textContent.trim().startsWith(label));
  if (!b) throw new Error(`no button "${label}"`);
  b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
};

let pass=0, fail=0;
const has = (name, ...needles) => {
  const t = copy();
  const missing = needles.filter((n) => !t.includes(n));
  missing.length ? (fail++, console.log(`FAIL  ${name}\n        missing: ${missing.join(" | ")}`))
                 : (pass++, console.log(`PASS  ${name}`));
};

/* HOME */
has("home: value, count, unrealised P/L", "410", "3 cards", "+282");
has("home: cards without market data flagged", "1 card without market data");
has("home: most valuable card surfaced", "Most valuable card", "Lionel Messi");
has("home: unidentified card labelled, not blank", "Unidentified card");

/* COLLECTION */
await click("Cards");
has("collection: total includes the sold card", "4 cards");
has("collection: badges render", "RC", "Auto", "23/50", "PSA 10");
has("collection: sold card marked", "Sold");
has("collection: filter chips present", "Panini", "Topps", "Rookie", "Relic");
await click("Set checklists");
has("checklist: progress against a manual set size", "Topps Chrome UEFA 2025", "2 / 200 collected");
has("checklist: missing numbers listed", "#1", "#2", "more");

/* WISHLIST */
await click("Wishlist");
has("wishlist: priced item", "Jude Bellingham", "55,00");
has("wishlist: unpriced item says so", "Insufficient market data");

/* PROFILE */
await click("Profile");
has("profile: account shown", "matic@example.com");
has("profile: invested excludes sold card", "128");
has("profile: realised profit from the sold card", "realised +30");
has("profile: derived stats", "Most valuable card", "Most expensive player", "Most represented player", "Most represented club");
has("profile: chart drew a line", "08-24", "08-27");
const paths = doc.querySelectorAll("svg path");
(paths.length >= 2 ? (pass++, console.log("PASS  chart: line and fill paths rendered"))
                   : (fail++, console.log("FAIL  chart: no svg paths")));

/* CARD DETAIL */
await click("Cards");
const row = [...doc.querySelectorAll("button")].find((b) => b.textContent.includes("Lionel Messi"));
row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));
has("detail: opens with value breakdown", "Estimated value", "Low", "Avg", "High", "6 comparable sales");
has("detail: paid / now / P/L", "Paid", "Now", "P/L", "+180");
has("detail: status controls", "In collection", "For sale", "Sold");
has("detail: notes shown", "Pulled from a UEFA blaster");

if (errors.length) { console.log("\nRUNTIME ERRORS:"); errors.forEach((e)=>console.log("  "+e)); }
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} runtime errors`);
process.exit(fail || errors.length ? 1 : 0);
