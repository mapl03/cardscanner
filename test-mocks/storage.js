export const EMPTY_DATA = { cards: [], wishlist: [], sets: {}, history: [], settings: { currency: "EUR", usdEur: 0.92 } };
export const setUid = () => {};
export const subscribe = (cb) => { setTimeout(() => cb(globalThis.__DATA__), 0); return () => {}; };
export const saveCard = async () => {}; export const deleteCard = async () => {};
export const saveWishlistItem = async () => {}; export const deleteWishlistItem = async () => {};
export const saveSettings = async () => {}; export const saveSets = async () => {};
export const saveHistory = async () => {}; export const restore = async () => {};
export const saveImages = async () => true; export const loadImages = async () => null;
export const imagesAsDataUrls = async () => null;
