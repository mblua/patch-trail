// Message protocol between the extension host and the Patch Trail webview.

export interface SiblingInfo { name: string; size: number }

export type TrajectorySource = "default" | "remembered" | "chosen";

export type HostToWebview =
  | { type: "patch"; text: string; name: string; fsPath: string; expectedTrajectory: string }
  | { type: "trajectory"; text: string; name: string; fsPath: string; source: TrajectorySource }
  | { type: "trajectoryMissing"; expected: string; siblings: SiblingInfo[]; error?: string }
  | { type: "trajectoryLoading"; name: string }
  | { type: "find" }
  /** Shows or hides a pane; without "visible" it toggles. */
  | { type: "toggle"; pane: "patch" | "trajectory" | "details"; visible?: boolean };

export interface CursorInfo {
  row: number;
  path: string | null;
  kind: string;
  old: number | null;
  new: number | null;
  hunkOld: number | null;
  hunkNew: number | null;
  turn: number | null;
}

export type WebviewToHost =
  | { type: "ready" }
  | { type: "cursor"; info: CursorInfo }
  | { type: "panes"; patch: boolean; trajectory: boolean; details: boolean }
  | { type: "openFile"; path: string; line: number; side: "old" | "new" }
  | { type: "copy"; text: string; label: string }
  | { type: "pickTrajectory" }
  | { type: "loadSibling"; name: string }
  | { type: "log"; message: string };
