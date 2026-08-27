import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the repository name, or every asset 404s on GitHub Pages.
// Repo at github.com/mapl03/cardscanner  ->  base: "/cardscanner/"
// Repo at yourname.github.io             ->  base: "/"
export default defineConfig({
  plugins: [react()],
  base: "/cardscanner/",
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the heavy libraries so a code change does not force phones
        // to re-download Firebase and the chart library as well.
        manualChunks: {
          firebase: ["firebase/app", "firebase/auth", "firebase/firestore", "firebase/storage"],
        },
      },
    },
  },
});
