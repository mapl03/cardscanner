import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Service worker gives the home-screen install prompt and offline app shell.
// Registered relative to the page so it works under a /repo-name/ base path.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("sw.js", document.baseURI))
      .catch((e) => console.warn("Service worker not registered:", e));
  });
}
