// Exact, shareable references: to text inside a trajectory step, and to patch rows.
import type { PatchLine } from "./patch";

export interface TextReference {
  /** e.g. "run.trajectory.jsonl:380 › payload.command › 6:26-49" */
  short: string;
  /** "6:26-49" or "6:26-8:3" (1-based, end column inclusive). */
  loc: string;
  start: number;
  text: string;
}

/** 1-based line and column of a character offset inside a value. */
export function lineCol(value: string, offset: number): [number, number] {
  const before = value.slice(0, offset);
  return [before.split("\n").length, offset - before.lastIndexOf("\n")];
}

/**
 * Builds a reference for value[start, start + text.length).
 * Returns null when the text is not exactly at that offset.
 */
export function makeReference(fileName: string, jsonlLine: number, fieldPath: string, value: string, start: number, text: string): TextReference | null {
  if (!text || value.slice(start, start + text.length) !== text) return null;
  const end = start + text.length;
  const [l1, c1] = lineCol(value, start);
  const [l2, c2] = lineCol(value, Math.max(start, end - 1));
  const loc = l1 === l2 ? l1 + ":" + c1 + "-" + c2 : l1 + ":" + c1 + "-" + l2 + ":" + c2;
  return { short: fileName + ":" + jsonlLine + " › " + fieldPath + " › " + loc, loc, start, text };
}

/** Clipboard text: the reference, the step, the exact position and the text itself. */
export function referenceText(ref: TextReference, step: string, fieldPath: string): string {
  const fence = ref.text.includes("```") ? "~~~" : "```";
  return "Reference: " + ref.short + "\n" +
    "Step: " + step + "\n" +
    "Position: line:column inside " + fieldPath + " (offset " + ref.start + ", " + ref.text.length + " characters)\n" +
    "Text:\n" + fence + "\n" + ref.text + "\n" + fence + "\n";
}

// ------------------------------------------------------------ patch lines

/** Text selected inside one patch row: offsets in the row text (start 0-based, end exclusive). */
export interface RowSelection { start: number; end: number; text: string }

/** The turn that wrote a patch line, as shown by the blame column. */
export interface LineTurn { turn: number | null; trajectory: string; line: number; inferred: boolean }

/** Path of the file a patch line belongs to, on the side the line number refers to. */
function sidePath(L: PatchLine): string {
  const f = L.file;
  if (!f) return "";
  const pick = L.kind === "del" ? f.oldPath : f.newPath;
  return pick && pick !== "/dev/null" ? pick : f.path;
}

/** Line in the file for a row: the new number for added and context lines, the original one for removed lines. */
export function fileLineOf(L: PatchLine): { line: number; side: "a" | "b" } | null {
  if (L.kind === "del") return L.old != null ? { line: L.old, side: "a" } : null;
  if (L.kind === "add" || L.kind === "ctx") return L.new != null ? { line: L.new, side: "b" } : null;
  return null;
}

/** Short reference to the file line of a row, e.g. "src/record/recorder.rs:29 (patch)"; null for header rows. */
export function fileLineReference(L: PatchLine): string | null {
  const fl = fileLineOf(L);
  return fl ? sidePath(L) + ":" + fl.line + " (patch)" : null;
}

/**
 * Short position of a row, e.g. "patch row 1209 · recorder.rs:29 (new)".
 * `base` turns a path into the name to show.
 */
export function rowPosition(L: PatchLine, base: (path: string) => string = (p) => p): string {
  const head = "patch row " + L.row;
  const path = sidePath(L);
  if (L.kind === "add" && L.new != null) return head + " · " + base(path) + ":" + L.new + " (new)";
  if (L.kind === "del" && L.old != null) return head + " · " + base(path) + ":" + L.old + " (original, removed)";
  if (L.kind === "ctx" && L.new != null) return head + " · " + base(path) + ":" + L.new + (L.old !== L.new ? " (original " + L.old + ")" : "");
  if (L.kind === "hunk" && L.file) return head + " · hunk of " + base(path);
  if (L.file) return head + " · header of " + base(path);
  return head;
}

/**
 * Clipboard text for a patch row, or for text selected inside it:
 * the patch row (and columns), the file line it stands for, the turn that wrote it and the text.
 * Patch columns are one more than file columns because of the "+", "-" or " " prefix.
 */
export function patchLineReference(patchName: string, L: PatchLine, sel?: RowSelection | null, turn?: LineTurn | null): string {
  let ref = patchName + ":" + L.row;
  if (sel) ref += ":" + (sel.start + 1) + "-" + Math.max(sel.start + 1, sel.end);
  const fl = fileLineOf(L);
  const path = sidePath(L);
  if (fl) {
    ref += " → " + path + ":" + fl.line;
    if (sel) ref += ":" + Math.max(1, sel.start) + "-" + Math.max(1, sel.end - 1);
    ref += L.kind === "add" ? " (new file b/, added line)"
      : L.kind === "del" ? " (original file a/, removed line)"
      : " (new file b/" + (L.old !== L.new ? "; original a/ " + L.old : "") + ")";
  } else if (L.kind === "hunk" && L.file) ref += " (hunk header of " + path + ")";
  else if (L.file) ref += " (file header of " + path + ")";
  const out = ["Reference: " + ref];
  if (turn) out.push("Turn: " + (turn.turn != null ? "T" + turn.turn : "step") + " · " + turn.trajectory + ":" + turn.line + (turn.inferred ? " (inherited from the neighbouring line)" : ""));
  const text = sel ? sel.text : L.text;
  const fence = text.includes("```") ? "~~~" : "```";
  out.push("Text:", fence, text, fence);
  return out.join("\n") + "\n";
}
