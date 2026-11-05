// Development harness: renders the webview in a plain browser with a mocked VS Code API.
// Usage: npm run build && node scripts/harness.mjs path/to/file.patch [path/to/trajectory.jsonl]
// Output: .harness/index.html (git-ignored: it embeds the given patch and trajectory).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const [patchArg, trajArg] = process.argv.slice(2);
if (!patchArg) {
  console.error("Usage: node scripts/harness.mjs path/to/file.patch [path/to/trajectory.jsonl]");
  process.exit(1);
}
const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const patchPath = resolve(patchArg);
const defaultTraj = patchPath + ".trajectory.jsonl";
const trajPath = trajArg ? resolve(trajArg) : existsSync(defaultTraj) ? defaultTraj : null;
const siblings = readdirSync(dirname(patchPath))
  .filter((n) => /\.(jsonl|ndjson)$/i.test(n))
  .map((n) => ({ name: n, size: statSync(join(dirname(patchPath), n)).size }));

const data = {
  patch: { type: "patch", text: readFileSync(patchPath, "utf8"), name: basename(patchPath), fsPath: patchPath, expectedTrajectory: defaultTraj },
  trajectory: trajPath ? { type: "trajectory", text: readFileSync(trajPath, "utf8"), name: basename(trajPath), fsPath: trajPath, source: trajArg ? "chosen" : "default" } : null,
  missing: { type: "trajectoryMissing", expected: defaultTraj, siblings },
};
const safe = (s) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
const js = readFileSync(join(root, "dist", "webview.js"), "utf8");
const css = readFileSync(join(root, "dist", "webview.css"), "utf8");

// A subset of the Dark Modern theme variables VS Code injects into webviews.
const theme = `
  --vscode-font-family: "Segoe WPC", "Segoe UI", sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, "Courier New", monospace; --vscode-editor-font-size: 14px;
  --vscode-editor-background: #1f1f1f; --vscode-editor-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-panel-border: #2b2b2b; --vscode-sideBar-background: #181818; --vscode-editorLineNumber-foreground: #6e7681;
  --vscode-editorLineNumber-activeForeground: #cccccc; --vscode-editor-lineHighlightBorder: #282828;
  --vscode-diffEditor-insertedLineBackground: rgba(155,185,85,.2); --vscode-diffEditor-removedLineBackground: rgba(255,0,0,.2);
  --vscode-gitDecoration-addedResourceForeground: #81b88b; --vscode-gitDecoration-deletedResourceForeground: #c74e39;
  --vscode-textLink-foreground: #4daafc; --vscode-charts-purple: #b180d7; --vscode-charts-red: #f14c4c; --vscode-charts-green: #89d185; --vscode-charts-yellow: #cca700;
  --vscode-editor-findMatchHighlightBackground: rgba(234,92,0,.33); --vscode-editor-findMatchBackground: #9e6a03; --vscode-editor-findMatchBorder: #e2a400;
  --vscode-editorWidget-background: #202020; --vscode-editorWidget-border: #313131; --vscode-widget-shadow: rgba(0,0,0,.36);
  --vscode-list-activeSelectionBackground: #04395e; --vscode-list-activeSelectionForeground: #ffffff; --vscode-list-hoverBackground: #2a2d2e;
  --vscode-focusBorder: #0078d4; --vscode-input-background: #313131; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff; --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc; --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-activityBar-background: #181818; --vscode-activityBar-foreground: #d7d7d7; --vscode-activityBar-inactiveForeground: #868686; --vscode-activityBar-activeBorder: #0078d4;
  --vscode-editorCursor-foreground: #aeafad; --vscode-textCodeBlock-background: #2b2b2b; --vscode-inputOption-activeBackground: rgba(36,137,219,.51);
  --vscode-editorWarning-foreground: #cca700; --vscode-errorForeground: #f85149;`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Patch Trail harness</title>
<style>html{${theme}}</style><style>${css}</style></head>
<body data-follow="true"><div id="app"></div>
<script>
window.__posted = []; window.__clipboard = null;
const DATA = ${safe(JSON.stringify(data))};
let state = null;
const send = (m) => setTimeout(() => window.postMessage(m, "*"), 0);
window.acquireVsCodeApi = () => ({
  getState: () => state, setState: (s) => { state = s; },
  postMessage(m) {
    window.__posted.push(m);
    if (m.type === "ready") { send(DATA.patch); send(DATA.trajectory || DATA.missing); }
    if (m.type === "copy") window.__clipboard = m.text;
    if (m.type === "pickTrajectory" || m.type === "loadSibling" || m.type === "openFile") console.log("[host]", JSON.stringify(m));
  },
});
window.__harness = { missing: () => send(DATA.missing), load: () => DATA.trajectory && send(DATA.trajectory), send };
</script>
<script>${safe(js)}</script>
</body></html>`;

mkdirSync(join(root, ".harness"), { recursive: true });
const out = join(root, ".harness", "index.html");
writeFileSync(out, html);
console.log("Harness written to " + out + (trajPath ? " (trajectory: " + basename(trajPath) + ")" : " (no trajectory)"));
