// Activity bar container "Patch Trail": the patches in the workspace and the current patch.
import * as vscode from "vscode";
import { currentSession, onDidChangeSessions } from "./patchEditor";
import { TrajectoryResolver, basename } from "./trajectoryResolver";

const PATCH_GLOB = "**/*.{patch,diff}";
const EXCLUDE_GLOB = "**/{node_modules,.git,.vscode-test}/**";
const MAX_PATCHES = 500;

// ------------------------------------------------------------ Patches
class PatchItem extends vscode.TreeItem {
  constructor(readonly uri: vscode.Uri, trajectory: { name: string; source: string } | undefined) {
    super(basename(uri), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.description = trajectory ? "⇄ " + trajectory.name : "no trajectory";
    this.tooltip = new vscode.MarkdownString(
      "**" + basename(uri) + "**\n\n" + vscode.workspace.asRelativePath(uri) + "\n\n" +
      (trajectory ? "Trajectory (" + trajectory.source + "): `" + trajectory.name + "`" : "No trajectory found next to it."),
    );
    this.iconPath = new vscode.ThemeIcon("diff", trajectory ? undefined : new vscode.ThemeColor("disabledForeground"));
    this.contextValue = "patchTrail.patch";
    this.command = { command: "patchTrail.openInPatchTrail", title: "Open in Patch Trail", arguments: [uri] };
  }
}

export class PatchesProvider implements vscode.TreeDataProvider<PatchItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly watcher = vscode.workspace.createFileSystemWatcher("**/*.{patch,diff,jsonl,ndjson}");
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly resolver: TrajectoryResolver) {
    const refresh = () => this.refreshSoon();
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
  }

  refresh(): void { this.emitter.fire(); }
  refreshSoon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 300);
  }

  getTreeItem(item: PatchItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<PatchItem[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const uris = await vscode.workspace.findFiles(PATCH_GLOB, EXCLUDE_GLOB, MAX_PATCHES);
    uris.sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)));
    return Promise.all(uris.map(async (u) => {
      const t = await this.resolver.resolve(u);
      return new PatchItem(u, t ? { name: basename(t.uri), source: t.source } : undefined);
    }));
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}

// ------------------------------------------------------------ Current patch
type CurrentKind = "patch" | "trajectory" | "pane-patch" | "pane-trajectory" | "pane-details" | "action";

class CurrentItem extends vscode.TreeItem {
  constructor(readonly kind: CurrentKind, label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

export class CurrentProvider implements vscode.TreeDataProvider<CurrentItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub = onDidChangeSessions(() => this.emitter.fire());

  getTreeItem(item: CurrentItem): vscode.TreeItem { return item; }

  getChildren(): CurrentItem[] {
    const s = currentSession();
    if (!s) return [];
    const items: CurrentItem[] = [];

    const patch = new CurrentItem("patch", basename(s.document.uri));
    patch.description = vscode.workspace.asRelativePath(s.document.uri);
    patch.iconPath = new vscode.ThemeIcon("diff");
    patch.tooltip = s.document.uri.fsPath;
    patch.command = { command: "patchTrail.focusCurrent", title: "Show the patch" };
    items.push(patch);

    const traj = new CurrentItem("trajectory", s.trajectoryName ?? "No trajectory");
    traj.description = s.trajectoryUri ? (s.trajectorySource === "default" ? "default" : s.trajectorySource === "remembered" ? "remembered" : "chosen") : "click to associate";
    traj.iconPath = new vscode.ThemeIcon("link", s.trajectoryUri ? undefined : new vscode.ThemeColor("editorWarning.foreground"));
    traj.tooltip = s.trajectoryUri ? s.trajectoryUri.fsPath : "No trajectory associated with this patch.";
    traj.command = { command: "patchTrail.associateTrajectory", title: "Associate Trajectory…" };
    items.push(traj);

    const pane = (kind: "pane-patch" | "pane-trajectory" | "pane-details", label: string, on: boolean, icon: string) => {
      const it = new CurrentItem(kind, label);
      it.checkboxState = on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      it.iconPath = new vscode.ThemeIcon(icon);
      it.tooltip = (on ? "Hide" : "Show") + " the " + label.toLowerCase();
      return it;
    };
    items.push(pane("pane-patch", "Patch pane", s.panes.patch, "file-code"));
    items.push(pane("pane-trajectory", "Trajectory pane", s.panes.trajectory, "list-tree"));
    items.push(pane("pane-details", "Line details panel", s.panes.details, "layout-panel"));

    const action = (label: string, command: string, icon: string) => {
      const it = new CurrentItem("action", label);
      it.iconPath = new vscode.ThemeIcon(icon);
      it.command = { command, title: label };
      return it;
    };
    items.push(action("Change trajectory…", "patchTrail.associateTrajectory", "folder-opened"));
    if (s.trajectorySource === "chosen" || s.trajectorySource === "remembered") items.push(action("Reset to the default trajectory", "patchTrail.resetTrajectory", "discard"));
    items.push(action("Find in patch and trajectory", "patchTrail.find", "search"));
    return items;
  }

  /** Checkbox clicks show or hide the panes of the current editor. */
  onCheckbox(e: vscode.TreeCheckboxChangeEvent<CurrentItem>): void {
    const s = currentSession();
    if (!s) return;
    for (const [item, state] of e.items) {
      const visible = state === vscode.TreeItemCheckboxState.Checked;
      if (item.kind === "pane-patch") s.setPane("patch", visible);
      if (item.kind === "pane-trajectory") s.setPane("trajectory", visible);
      if (item.kind === "pane-details") s.setPane("details", visible);
    }
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

export function registerSidebar(context: vscode.ExtensionContext, resolver: TrajectoryResolver): { patches: PatchesProvider; current: CurrentProvider } {
  const patches = new PatchesProvider(resolver);
  const current = new CurrentProvider();
  const currentView = vscode.window.createTreeView("patchTrail.current", { treeDataProvider: current });
  context.subscriptions.push(
    patches,
    current,
    vscode.window.createTreeView("patchTrail.patches", { treeDataProvider: patches, showCollapseAll: false }),
    currentView,
    currentView.onDidChangeCheckboxState((e) => current.onCheckbox(e)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => patches.refresh()),
    // a new association changes the "⇄ trajectory" label of a patch
    onDidChangeSessions(() => patches.refreshSoon()),
  );
  return { patches, current };
}
