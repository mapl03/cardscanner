/* Stand-in for src/firebase.js when gemini-test.mjs bundles the real src/ai.js. */
export const auth = { currentUser: { getIdToken: async () => "test-token" } };
export const configOk = true;
