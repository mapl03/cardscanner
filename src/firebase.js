import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

/* ============================================================================
   Firebase configuration.

   These values are NOT secret — Firebase web config is public by design and
   ships in every client bundle. Your data is protected by the rules in
   firestore.rules and storage.rules, not by hiding this object.

   Copy the values from:
     Firebase console -> Project settings -> Your apps -> SDK setup -> Config
============================================================================ */

export const firebaseConfig = {
  apiKey: "AIzaSyB4YSytPHJGXalXlJrA99q14cKpmikd5gs",
  authDomain: "card-scanner-b26ec.firebaseapp.com",
  projectId: "card-scanner-b26ec",
  storageBucket: "card-scanner-b26ec.firebasestorage.app",
  messagingSenderId: "857394386520",
  appId: "1:857394386520:web:56c78a96aa14713ae91c2d",
};

/** True once every placeholder has been replaced with a real value. */
export const configOk = !Object.values(firebaseConfig).some(
  (v) => typeof v !== "string" || v.startsWith("PASTE")
);

/* Analytics (measurementId + getAnalytics) is deliberately not wired up: it
   adds ~40 KB, loads Google tracking on every visit, and this app has no use
   for it. Add it later if you ever want install and usage numbers.

   A half-filled config fails quietly: auth appears to work, writes vanish.
   Fail loudly at startup instead — App.jsx renders a blocking banner. */
let app = null, auth = null, db = null, storage = null;
if (configOk) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
}

export { app, auth, db, storage };
