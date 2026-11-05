import * as vscode from "vscode";
import { PatchEditorProvider, VIEW_TYPE, currentSession, listSessions, type Panes } from "./host/patchEditor";
import { TrajectoryResolver } from "./host/trajectoryResolver";
import { StatusBar } from "./host/statusBar";
import { registerSidebar } from "./host/sidebar";

export interface PatchTrailApi {
  /** Open Patch Trail editors, the trajectory each one shows and its visible panes. */
  sessions(): { patch: string; trajectory: string | undefined; panes: Panes; current: boolean }[];
  /** Labels of the "Patches" view, then of the "Current patch" view. */
  sidebar(): Promise<{ patches: string[]; current: string[] }>;
}

export function activate(context: vscode.ExtensionContext): PatchTrailApi {
  const resolver = new TrajectoryResolver(context.workspaceState);
  const status = new StatusBar();
  const sidebar = registerSidebar(context, resolver);

  const needSession = () => {
    const s = currentSession();
    if (!s) void vscode.window.showInformationMessage("Patch Trail: open a .patch file in Patch Trail first.");
    return s;
  };
  const openInPatchTrail = (uri: vscode.Uri) => vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

  context.subscriptions.push(
    status,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new PatchEditorProvider(context, resolver, status), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),

    vscode.commands.registerCommand("patchTrail.openInPatchTrail", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) await openInPatchTrail(target);
      else await vscode.commands.executeCommand("patchTrail.openPatchFile");
    }),

    vscode.commands.registerCommand("patchTrail.openPatchFile", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Open in Patch Trail",
        title: "Open a patch in Patch Trail",
        filters: { "Patches": ["patch", "diff"], "All files": ["*"] },
      });
      if (picked?.[0]) await openInPatchTrail(picked[0]);
    }),

    vscode.commands.registerCommand("patchTrail.refreshPatches", () => sidebar.patches.refresh()),

    vscode.commands.registerCommand("patchTrail.focusCurrent", () => {
      const s = needSession();
      if (s) s.panel.reveal(undefined, false);
    }),

    vscode.commands.registerCommand("patchTrail.reopenAsText", async () => {
      const s = needSession();
      if (s) await vscode.commands.executeCommand("vscode.openWith", s.document.uri, "default");
    }),

    vscode.commands.registerCommand("patchTrail.associateTrajectory", async () => {
      const s = needSession();
      if (s) await s.associate();
    }),

    vscode.commands.registerCommand("patchTrail.resetTrajectory", async () => {
      const s = needSession();
      if (s) await s.resetAssociation();
    }),

    vscode.commands.registerCommand("patchTrail.find", () => {
      const s = needSession();
      if (!s) return;
      s.panel.reveal(undefined, false);
      s.post({ type: "find" });
    }),

    vscode.commands.registerCommand("patchTrail.copyRowReference", async (ctx?: { ref?: unknown }) => {
      if (typeof ctx?.ref !== "string") return;
      await vscode.env.clipboard.writeText(ctx.ref);
      vscode.window.setStatusBarMessage("Copied: " + ctx.ref, 3000);
    }),
    vscode.commands.registerCommand("patchTrail.togglePatch", () => needSession()?.setPane("patch")),
    vscode.commands.registerCommand("patchTrail.toggleTrajectory", () => needSession()?.setPane("trajectory")),
    vscode.commands.registerCommand("patchTrail.toggleDetails", () => needSession()?.setPane("details")),
    // The editor title bar shows one of each pair, depending on whether the pane is visible.
    vscode.commands.registerCommand("patchTrail.showPatch", () => needSession()?.setPane("patch", true)),
    vscode.commands.registerCommand("patchTrail.hidePatch", () => needSession()?.setPane("patch", false)),
    vscode.commands.registerCommand("patchTrail.showTrajectory", () => needSession()?.setPane("trajectory", true)),
    vscode.commands.registerCommand("patchTrail.hideTrajectory", () => needSession()?.setPane("trajectory", false)),
    vscode.commands.registerCommand("patchTrail.showDetails", () => needSession()?.setPane("details", true)),
    vscode.commands.registerCommand("patchTrail.hideDetails", () => needSession()?.setPane("details", false)),
  );

  return {
    sessions: listSessions,
    async sidebar() {
      const label = (t: vscode.TreeItem) => (typeof t.label === "string" ? t.label : t.label?.label ?? "");
      return {
        patches: (await sidebar.patches.getChildren()).map(label),
        current: sidebar.current.getChildren().map(label),
      };
    },
  };
}

export function deactivate(): void {
  /* nothing to clean up: everything is registered in context.subscriptions */
}
