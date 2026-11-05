import * as vscode from "vscode";
import type { SiblingInfo, TrajectorySource } from "../messages";

const KEY_PREFIX = "patchTrail.association:";

export interface ResolvedTrajectory { uri: vscode.Uri; source: TrajectorySource }

/**
 * Finds the trajectory associated with a patch:
 * 1. an association the user chose earlier (workspaceState),
 * 2. the default "<patch><suffix>" next to the patch (suffix: patchTrail.trajectorySuffix),
 * otherwise the user picks one with the native open dialog.
 */
export class TrajectoryResolver {
  constructor(private readonly state: vscode.Memento) {}

  suffix(): string {
    return vscode.workspace.getConfiguration("patchTrail").get<string>("trajectorySuffix", ".trajectory.jsonl");
  }

  defaultUri(patch: vscode.Uri): vscode.Uri {
    return patch.with({ path: patch.path + this.suffix() });
  }

  async resolve(patch: vscode.Uri): Promise<ResolvedTrajectory | undefined> {
    const remembered = this.state.get<string>(KEY_PREFIX + patch.toString());
    if (remembered) {
      const uri = vscode.Uri.parse(remembered);
      if (await exists(uri)) return { uri, source: "remembered" };
    }
    const def = this.defaultUri(patch);
    if (await exists(def)) return { uri: def, source: "default" };
    return undefined;
  }

  async remember(patch: vscode.Uri, trajectory: vscode.Uri | undefined): Promise<void> {
    await this.state.update(KEY_PREFIX + patch.toString(), trajectory ? trajectory.toString() : undefined);
  }

  /** Other .jsonl files in the patch folder. */
  async siblings(patch: vscode.Uri): Promise<SiblingInfo[]> {
    const dir = vscode.Uri.joinPath(patch, "..");
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      const out: SiblingInfo[] = [];
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !/\.(jsonl|ndjson)$/i.test(name)) continue;
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name));
        out.push({ name, size: stat.size });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async pick(patch: vscode.Uri): Promise<vscode.Uri | undefined> {
    const picked = await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.joinPath(patch, ".."),
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: "Associate Trajectory",
      title: "Associate a trajectory with " + basename(patch),
      filters: { "Trajectory (JSONL)": ["jsonl", "ndjson", "json"], "All files": ["*"] },
    });
    return picked?.[0];
  }
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    const s = await vscode.workspace.fs.stat(uri);
    return s.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

export function basename(uri: vscode.Uri): string {
  return uri.path.split("/").pop() || uri.path;
}
