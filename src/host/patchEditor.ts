import * as vscode from "vscode";
import type { CursorInfo, HostToWebview, TrajectorySource, WebviewToHost } from "../messages";
import { TrajectoryResolver, basename } from "./trajectoryResolver";
import { StatusBar } from "./statusBar";

export const VIEW_TYPE = "patchTrail.patchView";

/** Visible parts of the editor; "details" is the line details panel next to the patch. */
export interface Panes { patch: boolean; trajectory: boolean; details: boolean }

/** One open Patch Trail editor. */
export class PatchSession {
  trajectoryUri: vscode.Uri | undefined;
  trajectorySource: TrajectorySource | undefined;
  panes: Panes = { patch: true, trajectory: true, details: true };
  private lastCursor: CursorInfo | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly resolver: TrajectoryResolver,
    private readonly status: StatusBar,
  ) {}

  get trajectoryName(): string | undefined {
    return this.trajectoryUri ? basename(this.trajectoryUri) : undefined;
  }

  post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  start(): void {
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.document.uri.toString()) this.sendPatch();
      }),
      this.panel.onDidChangeViewState(() => {
        if (this.panel.active) setCurrent(this);
        else if (current === this && !this.panel.visible) setCurrent(sessions.find((s) => s.panel.visible));
        refreshStatus();
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  showStatus(): void {
    this.status.show(this.lastCursor, this.trajectoryName);
  }

  private sendPatch(): void {
    this.post({
      type: "patch",
      text: this.document.getText(),
      name: basename(this.document.uri),
      fsPath: this.document.uri.fsPath,
      expectedTrajectory: this.resolver.defaultUri(this.document.uri).fsPath,
    });
  }

  async loadTrajectory(uri: vscode.Uri | undefined, source: TrajectorySource): Promise<void> {
    if (!uri) {
      this.trajectoryUri = undefined;
      this.trajectorySource = undefined;
      this.post({
        type: "trajectoryMissing",
        expected: this.resolver.defaultUri(this.document.uri).fsPath,
        siblings: await this.resolver.siblings(this.document.uri),
      });
      changed();
      return;
    }
    this.post({ type: "trajectoryLoading", name: basename(uri) });
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder("utf-8").decode(bytes);
      this.trajectoryUri = uri;
      this.trajectorySource = source;
      this.post({ type: "trajectory", text, name: basename(uri), fsPath: uri.fsPath, source });
    } catch (err) {
      this.trajectoryUri = undefined;
      this.trajectorySource = undefined;
      this.post({
        type: "trajectoryMissing",
        expected: this.resolver.defaultUri(this.document.uri).fsPath,
        siblings: await this.resolver.siblings(this.document.uri),
        error: "Could not read " + uri.fsPath + ": " + String(err),
      });
    }
    changed();
  }

  async associate(): Promise<void> {
    const uri = await this.resolver.pick(this.document.uri);
    if (!uri) return;
    await this.resolver.remember(this.document.uri, uri);
    await this.loadTrajectory(uri, "chosen");
  }

  async resetAssociation(): Promise<void> {
    await this.resolver.remember(this.document.uri, undefined);
    const found = await this.resolver.resolve(this.document.uri);
    await this.loadTrajectory(found?.uri, found?.source ?? "default");
  }

  /** Shows or hides a pane; undefined toggles it. */
  setPane(pane: "patch" | "trajectory" | "details", visible?: boolean): void {
    this.post({ type: "toggle", pane, visible });
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case "ready": {
        this.sendPatch();
        const found = await this.resolver.resolve(this.document.uri);
        await this.loadTrajectory(found?.uri, found?.source ?? "default");
        break;
      }
      case "cursor":
        this.lastCursor = m.info;
        if (current === this) this.showStatus();
        break;
      case "panes":
        this.panes = { patch: m.patch, trajectory: m.trajectory, details: m.details };
        changed();
        break;
      case "pickTrajectory":
        await this.associate();
        break;
      case "loadSibling": {
        const uri = vscode.Uri.joinPath(this.document.uri, "..", m.name);
        await this.resolver.remember(this.document.uri, uri);
        await this.loadTrajectory(uri, "chosen");
        break;
      }
      case "copy":
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage("$(check) Patch Trail: copied " + m.label, 4000);
        break;
      case "openFile":
        await openPatchedFile(this.document.uri, m.path, m.line, m.side);
        break;
      case "log":
        console.log("[patch-trail webview]", m.message);
        break;
    }
  }
}

// ------------------------------------------------------------ open editors
const sessions: PatchSession[] = [];
/** The Patch Trail editor the user worked with last (it stays current while the sidebar has focus). */
let current: PatchSession | undefined;
const onDidChange = new vscode.EventEmitter<void>();
/** Fires when the current editor, its trajectory or its panes change. */
export const onDidChangeSessions = onDidChange.event;
let statusBar: StatusBar | undefined;

function changed(): void {
  refreshStatus();
  updateContext();
  onDidChange.fire();
}
function setCurrent(s: PatchSession | undefined): void {
  if (current === s) return;
  current = s;
  updateContext();
  onDidChange.fire();
}
/** Context keys that pick the on / off icon of the pane buttons in the editor title bar. */
function updateContext(): void {
  const p = current?.panes ?? { patch: true, trajectory: true, details: true };
  void vscode.commands.executeCommand("setContext", "patchTrail.patchVisible", p.patch);
  void vscode.commands.executeCommand("setContext", "patchTrail.trajectoryVisible", p.trajectory);
  void vscode.commands.executeCommand("setContext", "patchTrail.detailsVisible", p.details);
}
function refreshStatus(): void {
  if (!statusBar) return;
  if (current && current.panel.visible) current.showStatus();
  else statusBar.hide();
}

export function currentSession(): PatchSession | undefined {
  return current;
}

/** Open Patch Trail editors (used by the extension API and the integration tests). */
export function listSessions(): { patch: string; trajectory: string | undefined; panes: Panes; current: boolean }[] {
  return sessions.map((s) => ({ patch: s.document.uri.toString(), trajectory: s.trajectoryName, panes: { ...s.panes }, current: s === current }));
}

/** Opens the file a patch line belongs to, at that line. */
async function openPatchedFile(patch: vscode.Uri, relPath: string, line: number, side: "old" | "new"): Promise<void> {
  const candidates: vscode.Uri[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) candidates.push(vscode.Uri.joinPath(f.uri, relPath));
  // the patch may live inside (or next to) the repository it applies to
  let dir = vscode.Uri.joinPath(patch, "..");
  for (let i = 0; i < 4; i++) { candidates.push(vscode.Uri.joinPath(dir, relPath)); dir = vscode.Uri.joinPath(dir, ".."); }
  let target: vscode.Uri | undefined;
  for (const c of candidates) {
    try { await vscode.workspace.fs.stat(c); target = c; break; } catch { /* try next */ }
  }
  if (!target && vscode.workspace.workspaceFolders?.length) {
    const found = await vscode.workspace.findFiles("**/" + relPath, "**/node_modules/**", 1);
    target = found[0];
  }
  if (!target) {
    void vscode.window.showWarningMessage("Patch Trail: " + relPath + " was not found in the workspace.");
    return;
  }
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(pos, pos) });
  if (side === "old") {
    void vscode.window.setStatusBarMessage("Patch Trail: removed line — showing where it was in the current file", 5000);
  }
}

export class PatchEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resolver: TrajectoryResolver,
    private readonly status: StatusBar,
  ) {
    statusBar = status;
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = webviewHtml(panel.webview, dist);
    const session = new PatchSession(document, panel, this.resolver, this.status);
    sessions.push(session);
    session.start();
    setCurrent(session);
    panel.onDidDispose(() => {
      session.dispose();
      sessions.splice(sessions.indexOf(session), 1);
      if (current === session) setCurrent(sessions.find((s) => s.panel.active) ?? sessions.find((s) => s.panel.visible));
      refreshStatus();
    });
  }
}

function webviewHtml(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
  const follow = vscode.workspace.getConfiguration("patchTrail").get<boolean>("followCursor", true);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>Patch Trail</title>
</head>
<body data-follow="${follow}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
