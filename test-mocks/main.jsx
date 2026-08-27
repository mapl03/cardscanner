/* Test entry point. Loads the real src/App.jsx — never a copy of it — with the
   Firebase, storage and AI modules aliased to the mocks in this folder. */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App.jsx";

createRoot(document.getElementById("root")).render(<App />);
