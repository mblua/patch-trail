// Integration tests: run inside a real VS Code instance (see scripts/integration.mjs).
// They only use the synthetic fixtures, written into the temporary workspace folder.
import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { PatchTrailApi } from "../../src/extension";
import { PATCH, TRAJECTORY } from "../fixtures";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("Timed out waiting for " + what);
    await sleep(100);
  }
}
const activeTabViewType = () => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom ? input.viewType : undefined;
};

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let api: PatchTrailApi;
const dir = process.env.PATCH_TRAIL_IT_WORKSPACE!;
const withDefault = join(dir, "run.patch");
const withoutDefault = join(dir, "other.patch");
writeFileSync(withDefault, PATCH);
writeFileSync(withDefault + ".trajectory.jsonl", TRAJECTORY);
writeFileSync(withoutDefault, PATCH);
const session = (file: string) => api.sessions().find((x) => x.patch === vscode.Uri.file(file).toString());
const currentSession = () => api.sessions().find((x) => x.current);

test("activates and registers its commands", async () => {
  const ext = vscode.extensions.getExtension<PatchTrailApi>("mblua.patch-trail");
  assert.ok(ext, "extension not found");
  api = await ext.activate();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ["patchTrail.openInPatchTrail", "patchTrail.openPatchFile", "patchTrail.associateTrajectory", "patchTrail.resetTrajectory",
    "patchTrail.find", "patchTrail.reopenAsText", "patchTrail.togglePatch", "patchTrail.toggleTrajectory", "patchTrail.toggleDetails", "patchTrail.refreshPatches",
    "patchTrail.showPatch", "patchTrail.hidePatch", "patchTrail.showTrajectory", "patchTrail.hideTrajectory", "patchTrail.showDetails", "patchTrail.hideDetails"]) {
    assert.ok(cmds.includes(c), "missing command " + c);
  }
});

test("the activity bar icon opens the Patch Trail sidebar, listing the workspace patches", async () => {
  await vscode.commands.executeCommand("workbench.view.extension.patchTrail");
  const side = await waitFor("both patches in the sidebar", async () => {
    const s = await api.sidebar();
    return s.patches.length === 2 ? s : undefined;
  });
  assert.deepEqual(side.patches, ["other.patch", "run.patch"]);
  assert.deepEqual(side.current, [], "no current patch before opening one");
});

test("opens a .patch in the Patch Trail editor and loads the default trajectory", async () => {
  await vscode.commands.executeCommand("patchTrail.openInPatchTrail", vscode.Uri.file(withDefault));
  await waitFor("the custom editor tab", () => activeTabViewType() === "patchTrail.patchView");
  const s = await waitFor("the default trajectory", () => { const x = session(withDefault); return x?.trajectory ? x : undefined; });
  assert.equal(s.trajectory, "run.patch.trajectory.jsonl");
});

test("the sidebar shows the current patch with its trajectory and panes", async () => {
  const side = await waitFor("the current patch in the sidebar", async () => {
    const s = await api.sidebar();
    return s.current.includes("run.patch.trajectory.jsonl") ? s : undefined;
  });
  assert.deepEqual(side.current.slice(0, 5), ["run.patch", "run.patch.trajectory.jsonl", "Patch pane", "Trajectory pane", "Line details panel"]);
});

test("pane toggles reach the webview and come back as state", async () => {
  await vscode.commands.executeCommand("patchTrail.toggleTrajectory");
  await waitFor("the trajectory pane hidden", () => currentSession()?.panes.trajectory === false);
  await vscode.commands.executeCommand("patchTrail.toggleTrajectory");
  await waitFor("the trajectory pane shown", () => currentSession()?.panes.trajectory === true);
  await vscode.commands.executeCommand("patchTrail.togglePatch");
  await waitFor("the patch pane hidden", () => currentSession()?.panes.patch === false);
  await vscode.commands.executeCommand("patchTrail.togglePatch");
  await waitFor("the patch pane shown", () => currentSession()?.panes.patch === true);
  await vscode.commands.executeCommand("patchTrail.toggleDetails");
  await waitFor("the line details panel hidden", () => currentSession()?.panes.details === false);
  assert.equal(currentSession()?.panes.patch, true, "hiding the details keeps the patch");
  await vscode.commands.executeCommand("patchTrail.toggleDetails");
  await waitFor("the line details panel shown", () => currentSession()?.panes.details === true);
});

test("the editor title bar buttons show and hide each pane", async () => {
  for (const [name, key] of [["Trajectory", "trajectory"], ["Details", "details"], ["Patch", "patch"]] as const) {
    await vscode.commands.executeCommand("patchTrail.hide" + name);
    await waitFor(key + " hidden", () => currentSession()?.panes[key] === false);
    await vscode.commands.executeCommand("patchTrail.show" + name);
    await waitFor(key + " shown", () => currentSession()?.panes[key] === true);
  }
});

test("the current patch stays current while the sidebar has focus", async () => {
  await vscode.commands.executeCommand("workbench.view.extension.patchTrail");
  await vscode.commands.executeCommand("patchTrail.current.focus");
  await sleep(300);
  assert.equal(currentSession()?.patch, vscode.Uri.file(withDefault).toString());
  await vscode.commands.executeCommand("patchTrail.toggleTrajectory");
  await waitFor("toggle from the sidebar", () => currentSession()?.panes.trajectory === false);
  await vscode.commands.executeCommand("patchTrail.toggleTrajectory");
  await waitFor("toggle back", () => currentSession()?.panes.trajectory === true);
});

test("reports a missing trajectory when there is no default", async () => {
  await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(withoutDefault), "patchTrail.patchView");
  await waitFor("the second editor", () => session(withoutDefault));
  await waitFor("the second editor to be current", () => currentSession()?.patch === vscode.Uri.file(withoutDefault).toString());
  await sleep(1500);
  assert.equal(session(withoutDefault)?.trajectory, undefined);
  const side = await api.sidebar();
  assert.equal(side.current[1], "No trajectory");
});

test("editor-only commands run without errors", async () => {
  await vscode.commands.executeCommand("patchTrail.find");
  await vscode.commands.executeCommand("patchTrail.focusCurrent");
});

test("reopens the patch as plain text", async () => {
  await vscode.commands.executeCommand("patchTrail.openInPatchTrail", vscode.Uri.file(withDefault));
  await waitFor("Patch Trail active", () => activeTabViewType() === "patchTrail.patchView");
  await vscode.commands.executeCommand("patchTrail.reopenAsText");
  await waitFor("a text editor", () => vscode.window.activeTextEditor?.document.uri.fsPath.endsWith("run.patch"));
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("  ✓ " + name);
    } catch (err) {
      console.log("  ✗ " + name + "\n    " + String(err));
      failures.push(name);
    }
  }
  console.log(tests.length - failures.length + "/" + tests.length + " integration tests passed");
  if (failures.length) throw new Error(failures.length + " integration test(s) failed");
}
