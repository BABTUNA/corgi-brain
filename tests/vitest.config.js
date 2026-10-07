// Corgi Brain test suite: unit tests for the extension's fingerprinting, scoring and retry
// helpers, and end-to-end tests of the guide overlay against fixture pages (happy-dom).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup/chrome-mock.js"],
  },
});
