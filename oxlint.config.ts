import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: { node: true },
  rules: {
    // File and publication operations must preserve their sequence.
    "no-await-in-loop": "off",
    // Port implementations may complete synchronously through a Promise API.
    "require-await": "off",
    // Keep the extracted method variance and source names stable.
    "typescript/method-signature-style": "off",
    "unicorn/filename-case": "off",
    // Manifest field order and forward closures follow the existing wire implementation.
    "sort-keys": "off",
    "no-use-before-define": "off",
  },
  extends: [core],
});
