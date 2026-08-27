import {
  collection, doc, setDoc, deleteDoc, onSnapshot, getDoc,
} from "firebase/firestore";
import {
  ref, uploadString, getDownloadURL, deleteObject,
} from "firebase/storage";
import { db, storage } from "./firebase";

/* ============================================================================
   Storage layer. Everything that touches persistence lives here — swapping
   Firestore for anything else means rewriting this file and nothing else.

   Firestore layout
     users/{uid}/cards/{cardId}      one doc per card, thumbnails inline
     users/{uid}/wishlist/{itemId}
     users/{uid}/meta/prefs          { settings, sets }
     users/{uid}/meta/history        { points: [{d, v}] }

   Firebase Storage layout
     users/{uid}/cards/{cardId}/front.jpg
     users/{uid}/cards/{cardId}/back.jpg

   Full-size photos go to Storage, not Firestore: a Firestore document is
   capped at 1 MiB and two full scans blow straight past it. The ~30 KB
   thumbnails stay inline so lists render without a round trip per card.
============================================================================ */

let uid = null;
export function setUid(next) { uid = next; }

const cardsCol = () => collection(db, "users", uid, "cards");
const wishCol = () => collection(db, "users", uid, "wishlist");
const prefsDoc = () => doc(db, "users", uid, "meta", "prefs");
const historyDoc = () => doc(db, "users", uid, "meta", "history");

export const EMPTY_DATA = {
  cards: [],
  wishlist: [],
  sets: {},
  history: [],
  settings: { currency: "EUR", usdEur: 0.92 },
};

/**
 * Live-subscribe to everything this user owns. Calls back with the merged
 * shape the UI expects. Returns an unsubscribe function.
 *
 * Firestore answers local writes from cache before the server round trip,
 * so the UI updates instantly and reconciles when the write lands.
 */
export function subscribe(onData, onError) {
  if (!uid) return () => {};
  const state = { ...EMPTY_DATA, cards: [], wishlist: [] };
  let ready = { cards: false, wishlist: false, prefs: false, history: false };
  const emit = () => onData({ ...state, ready: Object.values(ready).every(Boolean) });
  const fail = (e) => onError && onError(e);

  const unsubs = [
    onSnapshot(cardsCol(), (snap) => {
      state.cards = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      ready.cards = true; emit();
    }, fail),

    onSnapshot(wishCol(), (snap) => {
      state.wishlist = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
      ready.wishlist = true; emit();
    }, fail),

    onSnapshot(prefsDoc(), (snap) => {
      const v = snap.data() || {};
      state.settings = { ...EMPTY_DATA.settings, ...(v.settings || {}) };
      state.sets = v.sets || {};
      ready.prefs = true; emit();
    }, fail),

    onSnapshot(historyDoc(), (snap) => {
      state.history = (snap.data() || {}).points || [];
      ready.history = true; emit();
    }, fail),
  ];

  return () => unsubs.forEach((u) => u());
}

/* ------------------------------------------------------------------ writes */

/** Strip undefined — Firestore rejects it, and blank card fields are full of it. */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export async function saveCard(card) {
  const { id, ...rest } = card;
  await setDoc(doc(cardsCol(), id), clean(rest), { merge: false });
}

export async function deleteCard(id) {
  await deleteDoc(doc(cardsCol(), id));
  await deleteImages(id);
}

export async function saveWishlistItem(item) {
  const { id, ...rest } = item;
  await setDoc(doc(wishCol(), id), clean(rest));
}

export async function deleteWishlistItem(id) {
  await deleteDoc(doc(wishCol(), id));
}

export async function saveSettings(settings) {
  await setDoc(prefsDoc(), { settings }, { merge: true });
}

export async function saveSets(sets) {
  await setDoc(prefsDoc(), { sets }, { merge: true });
}

export async function saveHistory(points) {
  await setDoc(historyDoc(), { points }, { merge: true });
}

/** Wipe and repopulate from a backup blob. */
export async function restore(data) {
  await Promise.all([
    saveSettings(data.settings || EMPTY_DATA.settings),
    saveSets(data.sets || {}),
    saveHistory(data.history || []),
    ...(data.cards || []).map(saveCard),
    ...(data.wishlist || []).map(saveWishlistItem),
  ]);
}

/* ------------------------------------------------------------------ images */

const imgRef = (cardId, side) => ref(storage, `users/${uid}/cards/${cardId}/${side}.jpg`);

/** Returns true when both sides uploaded. Failure is survivable — thumbnails remain. */
export async function saveImages(cardId, frontDataUrl, backDataUrl) {
  try {
    await Promise.all([
      uploadString(imgRef(cardId, "front"), frontDataUrl, "data_url"),
      uploadString(imgRef(cardId, "back"), backDataUrl, "data_url"),
    ]);
    return true;
  } catch (e) {
    console.error("image upload failed", e);
    return false;
  }
}

/** Returns { front, back } download URLs, or null when nothing is stored. */
export async function loadImages(cardId) {
  try {
    const [front, back] = await Promise.all([
      getDownloadURL(imgRef(cardId, "front")),
      getDownloadURL(imgRef(cardId, "back")),
    ]);
    return { front, back };
  } catch (e) {
    return null;
  }
}

export async function deleteImages(cardId) {
  await Promise.allSettled([
    deleteObject(imgRef(cardId, "front")),
    deleteObject(imgRef(cardId, "back")),
  ]);
}

/** Fetch a stored image back as a data URL, for duplicating a card. */
export async function imagesAsDataUrls(cardId) {
  const urls = await loadImages(cardId);
  if (!urls) return null;
  const grab = async (u) => {
    const blob = await (await fetch(u)).blob();
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(blob);
    });
  };
  return { front: await grab(urls.front), back: await grab(urls.back) };
}

export async function hasPrefs() {
  const snap = await getDoc(prefsDoc());
  return snap.exists();
}
