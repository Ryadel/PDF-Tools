import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "integration",
  files: "out/test/integration/**/*.test.js",
  // The highest version allowed by engines.vscode is the one the author uses.
  version: "1.140.0",
  // Other PDF extensions (e.g. vscode-pdf) must not interfere.
  launchArgs: ["--disable-extensions", "--disable-workspace-trust"],
  mocha: {
    ui: "tdd",
    timeout: 60_000,
  },
});
