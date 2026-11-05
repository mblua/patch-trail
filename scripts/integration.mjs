// Runs test/integration/suite.ts inside a downloaded VS Code (cached in .vscode-test/).
import * as esbuild from "esbuild";
import { runTests } from "@vscode/test-electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = join(root, "out", "integration", "suite.js");

await esbuild.build({
  entryPoints: [join(root, "test", "integration", "suite.ts")],
  outfile: suite,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  logLevel: "warning",
});

// The suite writes its synthetic fixtures into this folder, opened as the workspace.
const workspace = mkdtempSync(join(tmpdir(), "patch-trail-ws-"));

try {
  await runTests({
    version: process.env.VSCODE_TEST_VERSION || "stable",
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    extensionTestsEnv: { PATCH_TRAIL_IT_WORKSPACE: workspace },
    launchArgs: [workspace, "--disable-extensions", "--user-data-dir", mkdtempSync(join(tmpdir(), "patch-trail-ud-")), "--skip-welcome", "--skip-release-notes"],
  });
} catch (err) {
  console.error("Integration tests failed:", err);
  process.exit(1);
}
