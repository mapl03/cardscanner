/* Bundles the real src/App.jsx for the test run, swapping only the three
   modules that would need network or credentials. Everything else — the model,
   every screen, the chart — is the code that actually ships.

   A plugin is needed rather than esbuild's --alias flag because the imports
   being replaced are relative paths, which --alias cannot match. */

import * as esbuild from "esbuild";
import path from "node:path";

const MOCKS = {
  "./firebase": "test-mocks/firebase.js",
  "./storage": "test-mocks/storage.js",
  "./ai": "test-mocks/ai.js",
  "firebase/app": "test-mocks/fb-auth.js",
  "firebase/auth": "test-mocks/fb-auth.js",
  "firebase/firestore": "test-mocks/fb-auth.js",
  "firebase/storage": "test-mocks/fb-auth.js",
};

const swapMocks = {
  name: "swap-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const target = MOCKS[args.path];
      if (!target) return null;
      // Do not rewrite a mock's own imports back onto itself.
      if (args.importer.includes(`${path.sep}test-mocks${path.sep}`)) return null;
      return { path: path.resolve(target) };
    });
  },
};

await esbuild.build({
  entryPoints: ["test-mocks/main.jsx"],
  bundle: true,
  format: "iife",
  outfile: "test-build.js",
  plugins: [swapMocks],
  define: {
    "import.meta.env.PROD": "false",
    "import.meta.env.VITE_API_PROXY": '"https://test.workers.dev"',
    "process.env.NODE_ENV": '"development"',
  },
  logLevel: "warning",
});
