import * as vscode from "vscode";
import type { CursorInfo } from "../messages";

/** Status bar items shown while a Patch Trail editor is active. */
export class StatusBar implements vscode.Disposable {
  private readonly position = vscode.window.createStatusBarItem("patchTrail.position", vscode.StatusBarAlignment.Right, 101);
  private readonly trajectory = vscode.window.createStatusBarItem("patchTrail.trajectory", vscode.StatusBarAlignment.Right, 102);

  constructor() {
    this.position.name = "Patch Trail: Position";
    this.trajectory.name = "Patch Trail: Trajectory";
    this.trajectory.command = "patchTrail.associateTrajectory";
  }

  show(cursor: CursorInfo | undefined, trajectoryName: string | undefined): void {
    if (cursor && cursor.path) {
      const file = cursor.path.split("/").pop();
      const old = cursor.kind === "hunk" ? cursor.hunkOld : cursor.old;
      const nw = cursor.kind === "hunk" ? cursor.hunkNew : cursor.new;
      this.position.text = "$(diff) " + file + "  old " + (old ?? "—") + " · new " + (nw ?? "—") + (cursor.turn != null ? "  $(person) T" + cursor.turn : "");
      this.position.tooltip = cursor.path + "\nPatch row " + cursor.row + (cursor.turn != null ? "\nWritten in agent turn " + cursor.turn : "");
    } else {
      this.position.text = "$(diff) " + (cursor ? "patch row " + cursor.row : "Patch Trail");
      this.position.tooltip = undefined;
    }
    this.position.show();
    if (trajectoryName) {
      this.trajectory.text = "$(link) " + trajectoryName;
      this.trajectory.tooltip = "Associated trajectory. Click to associate another one.";
      this.trajectory.backgroundColor = undefined;
    } else {
      this.trajectory.text = "$(link) No trajectory · Associate…";
      this.trajectory.tooltip = "No trajectory associated with this patch. Click to pick one.";
      this.trajectory.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    this.trajectory.show();
  }

  hide(): void {
    this.position.hide();
    this.trajectory.hide();
  }

  dispose(): void {
    this.position.dispose();
    this.trajectory.dispose();
  }
}
