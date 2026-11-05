// Unified-diff parser: maps every row of a .patch to the real line numbers
// of the original (a/) and new (b/) file.

export type LineKind =
  | "meta" | "diff" | "fileOld" | "fileNew" | "hunk"
  | "add" | "del" | "ctx" | "nonl";

export type FileStatus = "modified" | "added" | "deleted" | "renamed";

export interface PatchLine {
  /** 1-based row in the .patch file. */
  row: number;
  text: string;
  kind: LineKind;
  file: PatchFile | null;
  hunk: Hunk | null;
  /** Line number in the original file (context and deleted lines). */
  old: number | null;
  /** Line number in the new file (context and added lines). */
  new: number | null;
  /** For added lines: the original line that follows the insertion point. */
  oldAnchor: number | null;
  /** For deleted lines: the new line that follows the removal point. */
  newAnchor: number | null;
}

export interface Hunk {
  index: number;
  file: PatchFile;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the second "@@" (usually the enclosing function). */
  context: string;
  startRow: number;
  endRow: number;
  add: number;
  del: number;
  body: PatchLine[];
}

export interface PatchFile {
  index: number;
  path: string;
  oldPath: string;
  newPath: string;
  status: FileStatus;
  startRow: number;
  endRow: number;
  hunks: Hunk[];
  add: number;
  del: number;
}

export interface PatchModel {
  lines: PatchLine[];
  files: PatchFile[];
}

function stripPrefix(p: string): string {
  p = p.split("\t")[0].trim();
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

export function parsePatch(text: string): PatchModel {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();

  const lines: PatchLine[] = [];
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: Hunk | null = null;
  let oldN = 0, newN = 0, oldRem = 0, newRem = 0;

  const newFile = (row: number): PatchFile => {
    const f: PatchFile = {
      index: files.length, path: "", oldPath: "", newPath: "", status: "modified",
      startRow: row, endRow: row, hunks: [], add: 0, del: 0,
    };
    files.push(f);
    hunk = null;
    oldRem = newRem = 0;
    return f;
  };

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const L: PatchLine = {
      row: i + 1, text: t, kind: "meta", file: null, hunk: null,
      old: null, new: null, oldAnchor: null, newAnchor: null,
    };
    const h = hunk as Hunk | null;
    const inHunk = h !== null && (oldRem > 0 || newRem > 0);

    if (inHunk && h && file) {
      const c = t[0];
      if (c === "+") {
        L.kind = "add"; L.new = newN++; L.oldAnchor = oldN; newRem--; h.add++; file.add++;
      } else if (c === "-") {
        L.kind = "del"; L.old = oldN++; L.newAnchor = newN; oldRem--; h.del++; file.del++;
      } else if (c === "\\") {
        L.kind = "nonl";
      } else {
        L.kind = "ctx"; L.old = oldN++; L.new = newN++; oldRem--; newRem--;
      }
      h.body.push(L);
    } else if (t.startsWith("\\") && h) {
      L.kind = "nonl";
      h.body.push(L);
    } else if (t.startsWith("diff --git ")) {
      file = newFile(L.row);
      const m = /^diff --git (\S+) (\S+)/.exec(t);
      if (m) {
        file.oldPath = stripPrefix(m[1]);
        file.newPath = stripPrefix(m[2]);
        file.path = file.newPath;
      }
      L.kind = "diff";
    } else if (t.startsWith("--- ")) {
      if (!file || file.hunks.length) file = newFile(L.row);
      file.oldPath = stripPrefix(t.slice(4));
      if (!file.path) file.path = file.oldPath;
      L.kind = "fileOld";
    } else if (t.startsWith("+++ ") && file) {
      file.newPath = stripPrefix(t.slice(4));
      file.path = file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
      if (file.newPath === "/dev/null") file.status = "deleted";
      if (file.oldPath === "/dev/null") file.status = "added";
      L.kind = "fileNew";
    } else if (t.startsWith("@@ ") && file) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(t);
      if (m) {
        const nh: Hunk = {
          index: file.hunks.length, file,
          oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
          newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
          context: m[5] || "", startRow: L.row, endRow: L.row, add: 0, del: 0, body: [],
        };
        file.hunks.push(nh);
        hunk = nh;
        oldN = nh.oldStart; newN = nh.newStart;
        oldRem = nh.oldCount; newRem = nh.newCount;
        L.kind = "hunk";
      }
    } else if (file) {
      if (/^new file mode/.test(t)) file.status = "added";
      else if (/^deleted file mode/.test(t)) file.status = "deleted";
      else if (/^rename (from|to) /.test(t)) file.status = "renamed";
    }

    if (file) { L.file = file; file.endRow = L.row; }
    const cur = hunk as Hunk | null;
    if (cur && L.kind !== "diff" && L.kind !== "fileOld") { L.hunk = cur; cur.endRow = L.row; }
    lines.push(L);
  }
  return { lines, files };
}

/** "290–295", "290" or "∅ (after 289)" for an empty range. */
export function rangeText(start: number, count: number): string {
  if (count === 0) return "∅ (after " + start + ")";
  return count === 1 ? String(start) : start + "–" + (start + count - 1);
}

export interface LineDescription {
  path: string | null;
  /** The most useful real line for this row (for "open file at this line"). */
  primary: { side: "old" | "new"; line: number } | null;
  hint: string;
}

export function describe(L: PatchLine): LineDescription {
  const d: LineDescription = { path: L.file ? L.file.path : null, primary: null, hint: "" };
  if (L.kind === "add") {
    d.primary = { side: "new", line: L.new! };
    d.hint = "added line · not in the original (inserted before old " + L.oldAnchor + ")";
  } else if (L.kind === "del") {
    d.primary = { side: "old", line: L.old! };
    d.hint = "removed line · not in the new file (was before new " + L.newAnchor + ")";
  } else if (L.kind === "ctx") {
    d.primary = { side: "new", line: L.new! };
    d.hint = "context · same in both files";
  } else if (L.kind === "hunk" && L.hunk) {
    const h = L.hunk;
    d.primary = { side: "new", line: Math.max(1, h.newStart) };
    d.hint = "hunk start · old " + rangeText(h.oldStart, h.oldCount) + " → new " + rangeText(h.newStart, h.newCount);
  } else if (L.kind === "nonl") {
    d.hint = "marker: no newline at end of file";
  } else if (L.file) {
    d.hint = "file header";
  } else {
    d.hint = "outside any file";
  }
  return d;
}

export interface SidePair { left: PatchLine | null; right: PatchLine | null }

/** Pairs a hunk body into side-by-side rows. */
export function sideBySide(hunk: Hunk): SidePair[] {
  const out: SidePair[] = [];
  let dels: PatchLine[] = [], adds: PatchLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ left: dels[i] || null, right: adds[i] || null });
    dels = []; adds = [];
  };
  for (const L of hunk.body) {
    if (L.kind === "del") { if (adds.length) flush(); dels.push(L); }
    else if (L.kind === "add") adds.push(L);
    else if (L.kind === "ctx") { flush(); out.push({ left: L, right: L }); }
  }
  flush();
  return out;
}
