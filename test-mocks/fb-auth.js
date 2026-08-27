export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(globalThis.__USER__ || null), 0); return () => {}; };
export const signInWithEmailAndPassword = async () => {};
export const createUserWithEmailAndPassword = async () => {};
export const signOut = async () => {};

/* Firestore / Storage / app stubs — src/storage.js imports these but the mock
   storage layer below never calls them, so no-ops are enough. */
export const initializeApp = () => ({});
export const getAuth = () => ({ currentUser: null });
export const getFirestore = () => ({}); export const getStorage = () => ({});
export const collection = () => ({}); export const doc = () => ({});
export const setDoc = async () => {}; export const deleteDoc = async () => {};
export const onSnapshot = () => () => {}; export const getDoc = async () => ({ exists: () => false });
export const ref = () => ({}); export const uploadString = async () => {};
export const getDownloadURL = async () => ""; export const deleteObject = async () => {};
