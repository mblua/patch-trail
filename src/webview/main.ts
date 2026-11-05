// Patch Trail webview: patch editor with real old/new line numbers, per-line agent blame,
// "why this line exists" panel, trajectory table + step detail, cross find and exact references.

import "./style.css";
import { describe, parsePatch, rangeText, sideBySide, type PatchLine, type PatchModel, type Hunk } from "../core/patch";
import { fieldPath, fields, link, locateInCommand, parseTrajectory, stepLabel, type LinkResult, type Origin, type Step, type Trajectory } from "../core/trajectory";
import { fileLineOf, fileLineReference, makeReference, patchLineReference, referenceText, rowPosition, type RowSelection, type TextReference } from "../core/reference";
import type { HostToWebview, SiblingInfo, WebviewToHost, TrajectorySource } from "../messages";

interface VsCodeApi { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();
const post = (m: WebviewToHost) => vscode.postMessage(m);

// ---------------------------------------------------------------- state
interface UiState { row: number; showPatch: boolean; showTraj: boolean; showDetails: boolean; split: number; follow: boolean; filter: Filter; hiddenCols: GutterCol[] }
type Filter = "all" | "model" | "cmd" | "write" | "hits";
/** Gutter columns of the patch: patch row, line in the file, turn that wrote the line. */
type GutterCol = "row" | "file" | "turn";
const saved = (vscode.getState() || {}) as Partial<UiState>;
const ui: UiState = {
  row: saved.row ?? 1,
  showPatch: saved.showPatch ?? true,
  showTraj: saved.showTraj ?? true,
  showDetails: saved.showDetails ?? true,
  split: saved.split ?? 52,
  follow: saved.follow ?? document.body.dataset.follow !== "false",
  filter: saved.filter ?? "all",
  hiddenCols: saved.hiddenCols ?? [],
};
const persist = () => vscode.setState(ui);

const S = {
  pm: null as PatchModel | null,
  patchName: "",
  expectedTrajectory: "",
  tr: null as Trajectory | null,
  trName: "",
  trSource: "default" as TrajectorySource,
  links: null as LinkResult | null,
  missing: null as { expected: string; siblings: SiblingInfo[]; error?: string } | null,
  loadingName: "the trajectory",
  focus: "patch" as "patch" | "traj",
  q: "", cs: false, findOpen: false, qDone: "",
  pMatches: [] as { row: number; idx: number }[], pCur: -1,
  sbsHunk: null as Hunk | null,
};

// ---------------------------------------------------------------- helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const baseName = (p: string | null | undefined) => (p || "").split(/[\\/]/).pop() || "";
const clip = (t: string | null | undefined, n: number) => { const s = String(t ?? ""); return s.length > n ? s.slice(0, n) : s; };
const fmtMs = (ms: number | null) => (ms == null ? "" : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");
const turnColor = (n: number) => "hsl(" + ((n * 47) % 360) + " 62% 68%)";
const line = (r: number) => S.pm!.lines[r - 1];
const originOf = (L: PatchLine): Origin | undefined => S.links?.origins.get(L);

function findAll(text: string | null | undefined, q: string, cs: boolean, limit = 20000): number[] {
  if (!q || text == null) return [];
  const T = cs ? String(text) : String(text).toLowerCase(), Q = cs ? q : q.toLowerCase();
  const out: number[] = [];
  let i = T.indexOf(Q);
  while (i !== -1 && out.length < limit) { out.push(i); i = T.indexOf(Q, i + Q.length); }
  return out;
}
const countAll = (text: string | null | undefined) => (S.q ? findAll(text, S.q, S.cs).length : 0);

interface Range { a: number; b: number; cls: string }
/** Escapes text and wraps (possibly overlapping) ranges in <mark>. */
function markup(text: string, ranges: Range[]): string {
  if (!ranges.length) return esc(text);
  const pts = new Set<number>([0, text.length]);
  for (const r of ranges) { pts.add(Math.max(0, Math.min(text.length, r.a))); pts.add(Math.max(0, Math.min(text.length, r.b))); }
  const P = Array.from(pts).sort((x, y) => x - y);
  let out = "";
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    if (a === b) continue;
    const seg = esc(text.slice(a, b));
    const cls = new Set<string>();
    for (const r of ranges) if (r.a <= a && r.b >= b) cls.add(r.cls);
    out += cls.size ? '<mark class="' + Array.from(cls).join(" ") + '">' + seg + "</mark>" : seg;
  }
  return out;
}
/** Escape + highlight the current search query (+ extra ranges). */
function hl(text: string | null | undefined, extra: Range[] = [], curAt = -1): string {
  const t = String(text ?? "");
  const r = extra.slice();
  if (S.q) for (const i of findAll(t, S.q, S.cs, 3000)) r.push({ a: i, b: i + S.q.length, cls: i === curAt ? "m cur" : "m" });
  return markup(t, r);
}

let toastTimer = 0;
function toast(html: string): void {
  const t = $("#toast");
  t.innerHTML = html;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("on"), 3200);
}

// ---------------------------------------------------------------- skeleton

$("#app").innerHTML = `
<div class="shell">
  <div class="groups" id="groups">
    <section class="group" id="g-patch">
      <div class="g-head"><span class="crumb" id="crumb"></span><span class="g-actions"><button id="copy-line-ref" class="tgl" title="Copy a reference to the cursor line, or to the text selected in it">Copy reference</button><button id="toggle-details" class="tgl" title="Show or hide the line details panel (D)">Details</button><button id="hide-patch" title="Hide the patch (also in the editor title bar)">✕</button></span></div>
      <div class="patch-content" id="patch-content">
        <div class="editor-wrap">
          <div class="find" id="find-patch"></div>
          <div class="sticky-turn" id="sticky-turn" hidden></div>
          <div class="editor" id="editor" tabindex="0"><div class="spacer" id="spacer"><div class="rows" id="rows"></div></div></div>
          <div class="colbar" id="colbar"></div>
        </div>
        <div class="pos-panel" id="pos-panel">
          <div class="pp-left"><div class="pos-card" id="pos-card"></div><div class="link-box" id="link-box"></div></div>
          <div class="pp-right">
            <div class="pp-title"><span id="sbs-title">Hunk side by side</span><span class="nav"><button data-nav="-1" title="Previous hunk (P)">↑ hunk</button><button data-nav="1" title="Next hunk (N)">↓ hunk</button><button class="close" id="hide-details" title="Hide the line details panel (D)">✕</button></span></div>
            <div class="sbs" id="sbs"></div>
          </div>
        </div>
      </div>
    </section>
    <div class="sash" id="sash"></div>
    <section class="group" id="g-traj">
      <div class="g-head"><span class="crumb" id="traj-name"></span><span class="g-actions"><button id="change-traj" title="Associate another trajectory">Change…</button><button id="hide-traj" title="Hide the trajectory (also in the editor title bar)">✕</button></span></div>
      <div class="traj-content"><div class="find" id="find-traj"></div><div class="traj-view" id="traj-view"></div></div>
    </section>
    <div class="groups-empty">Nothing visible.<br>Use the <b>Show Patch</b> and <b>Show Trajectory</b> buttons in the editor title bar.</div>
  </div>
</div>
<div class="toast" id="toast" role="status"></div>`;

// ---------------------------------------------------------------- layout
function applyLayout(): void {
  const p = ui.showPatch, t = ui.showTraj;
  $("#g-patch").hidden = !p;
  $("#g-traj").hidden = !t;
  const g = $("#groups");
  g.classList.toggle("solo", p !== t);
  g.classList.toggle("none", !p && !t);
  const pc = $("#patch-content");
  pc.classList.toggle("row", !(p && t));
  pc.classList.toggle("col", p && t);
  $("#pos-panel").hidden = !ui.showDetails;
  const td = $("#toggle-details");
  td.classList.toggle("on", ui.showDetails);
  td.setAttribute("aria-pressed", String(ui.showDetails));
  td.title = (ui.showDetails ? "Hide" : "Show") + " the line details panel (D)";
  $("#g-patch").style.flexBasis = p && t ? ui.split + "%" : "";
  $("#g-traj").style.flexBasis = p && t ? 100 - ui.split + "%" : "";
  updateFindWidgets();
  renderRows(true);
  const key = p + "/" + t + "/" + ui.showDetails;
  if (key !== lastPanes) { lastPanes = key; post({ type: "panes", patch: p, trajectory: t, details: ui.showDetails }); }
}
let lastPanes = "";
/** Shows or hides the line details panel; showing it also shows the patch it belongs to. */
function toggleDetails(force?: boolean): void {
  ui.showDetails = force ?? !ui.showDetails;
  persist();
  if (ui.showDetails && !ui.showPatch) { toggle("patch", true); return; }
  applyLayout();
  // The panel keeps updating while hidden, so only the cursor row has to stay in view.
  if (S.pm) revealRow(ui.row);
}
function toggle(which: "patch" | "traj", force?: boolean): void {
  if (which === "patch") ui.showPatch = force ?? !ui.showPatch;
  else ui.showTraj = force ?? !ui.showTraj;
  persist();
  applyLayout();
  if (which === "patch" && ui.showPatch) revealRow(ui.row, true);
  if ((which === "patch" ? ui.showPatch : ui.showTraj)) setFocus(which);
}
function setFocus(which: "patch" | "traj"): void {
  S.focus = which;
  $("#g-patch").classList.toggle("focused", which === "patch");
  $("#g-traj").classList.toggle("focused", which === "traj");
}
$("#hide-patch").addEventListener("click", () => toggle("patch", false));
$("#hide-traj").addEventListener("click", () => toggle("traj", false));
$("#toggle-details").addEventListener("click", () => toggleDetails());
$("#hide-details").addEventListener("click", () => toggleDetails(false));
$("#change-traj").addEventListener("click", () => post({ type: "pickTrajectory" }));
$("#g-traj").addEventListener("mousedown", () => setFocus("traj"), true);
$("#g-patch").addEventListener("mousedown", () => setFocus("patch"), true);

$("#sash").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const sash = $("#sash");
  sash.classList.add("drag");
  const box = $("#groups").getBoundingClientRect();
  const move = (ev: MouseEvent) => { ui.split = Math.max(22, Math.min(78, ((ev.clientX - box.left) / box.width) * 100)); applyLayout(); };
  const up = () => { sash.classList.remove("drag"); persist(); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// ---------------------------------------------------------------- patch editor (virtualized)
const ROW_H = 20;
let rendered = { first: -1, last: -1 };
const editor = $("#editor");

function blameCell(L: PatchLine): string {
  if (L.kind !== "add" && L.kind !== "del") return '<span class="g-blame"></span>';
  const o = originOf(L);
  if (!o) return '<span class="g-blame"></span>';
  const prev = L.row > 1 ? line(L.row - 1) : null;
  const same = prev && (prev.kind === "add" || prev.kind === "del") && originOf(prev)?.step === o.step;
  const c = turnColor(o.step.turn ?? 0);
  return '<span class="g-blame"><span class="bar" style="background:' + c + '"></span>' +
    (same ? "" : '<span class="chip' + (o.inferred ? " inf" : "") + '" data-blame="' + L.row + '" style="background:' + c + '" title="Written in agent turn ' + o.step.turn + " (line " + o.step.line + ' of the trajectory)">T' + o.step.turn + "</span>") + "</span>";
}
function lineTextHTML(L: PatchLine): string {
  if (!L.text) return " ";
  if (!S.q) return esc(L.text);
  const cur = S.pMatches[S.pCur];
  return hl(L.text, [], cur && cur.row === L.row ? cur.idx : -1);
}
/** Line in the file: "a 29" for a removed line (original file), "b 29" for an added one (new file), the new number for context. */
function fileCell(L: PatchLine): string {
  const f = fileLineOf(L);
  if (f) {
    const cls = L.kind === "del" ? " old" : L.kind === "add" ? " new" : "";
    const mark = L.kind === "del" ? "a" : L.kind === "add" ? "b" : "";
    const title = L.kind === "del" ? "Line " + f.line + " of the original file (a/)" : L.kind === "add" ? "Line " + f.line + " of the new file (b/)" : "Line " + f.line + " of the new file (line " + L.old + " of the original)";
    return '<span class="g-file' + cls + '" title="' + title + '"><span class="side">' + mark + "</span>" + f.line + "</span>";
  }
  if (L.kind === "hunk" && L.hunk) return '<span class="g-file hk" title="The hunk starts at line ' + L.hunk.newStart + ' of the new file">' + L.hunk.newStart + "</span>";
  return '<span class="g-file"></span>';
}
function lineHTML(L: PatchLine): string {
  const runs = originOf(line(ui.row))?.step;
  const inRun = runs && originOf(L)?.step === runs;
  const hid = ui.hiddenCols;
  // Native context menu: VS Code passes this object to patchTrail.copyRowReference ("Copy Reference").
  const ref = fileLineReference(L);
  const ctx = ref ? ' data-vscode-context="' + esc(JSON.stringify({ webviewSection: "patchRow", ref })) + '"' : "";
  return '<div class="ln k-' + L.kind + (L.row === ui.row ? " cur" : "") + (inRun ? " linkrun" : "") + '" data-row="' + L.row + '"' + ctx + ">" +
    (hid.includes("row") ? "" : '<span class="g-row">' + L.row + "</span>") +
    (hid.includes("file") ? "" : fileCell(L)) +
    (hid.includes("turn") ? "" : blameCell(L)) +
    '<span class="txt">' + lineTextHTML(L) + "</span></div>";
}

// ---------------------------------------------------------------- gutter columns + cursor position strip
const COLS: { key: GutterCol; label: string; name: string; width: number }[] = [
  { key: "row", label: "#", name: "patch row", width: 56 },
  { key: "file", label: "a/b", name: "file line", width: 64 },
  { key: "turn", label: "T", name: "turn", width: 74 },
];
function renderColbar(): void {
  $("#colbar").innerHTML = COLS.map((c) => {
    const off = ui.hiddenCols.includes(c.key);
    return '<button data-col="' + c.key + '" class="' + (off ? "off" : "") + '"' + (off ? "" : ' style="width:' + c.width + 'px"') +
      ' title="' + (off ? "Show" : "Hide") + " the " + c.name + ' column">' + (off ? "+ " + c.label : esc(c.label) + ' <span class="x">✕</span>') + "</button>";
  }).join("") + '<span class="pos" id="cursor-pos"></span>';
  updateCursorPos();
}
function updateCursorPos(): void {
  const el = document.getElementById("cursor-pos");
  if (!el) return;
  el.textContent = S.pm && S.pm.lines.length ? rowPosition(line(ui.row), baseName) : "";
  el.title = el.textContent;
}
$("#colbar").addEventListener("mousedown", (e) => e.preventDefault());
$("#colbar").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-col]");
  if (!b) return;
  const k = b.dataset.col as GutterCol;
  ui.hiddenCols = ui.hiddenCols.includes(k) ? ui.hiddenCols.filter((x) => x !== k) : [...ui.hiddenCols, k];
  persist();
  renderColbar();
  renderRows(true);
});

// ---------------------------------------------------------------- copy a reference to the cursor row
/** Text selected inside a single patch row, with its offsets in the row text. */
function rowSelection(): { L: PatchLine; sel: RowSelection } | null {
  const s = window.getSelection();
  if (!S.pm || !s || s.isCollapsed || !s.rangeCount) return null;
  const r = s.getRangeAt(0);
  const startEl = r.startContainer.nodeType === Node.ELEMENT_NODE ? (r.startContainer as Element) : r.startContainer.parentElement;
  const txt = startEl?.closest<HTMLElement>(".ln .txt");
  if (!txt || !txt.contains(r.endContainer)) return null;
  const L = line(+txt.parentElement!.dataset.row!);
  const pre = document.createRange();
  pre.selectNodeContents(txt);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length, text = r.toString();
  if (!text || L.text.slice(start, start + text.length) !== text) return null;
  return { L, sel: { start, end: start + text.length, text } };
}
function copyLineReference(): void {
  if (!S.pm || !S.pm.lines.length) return;
  const picked = rowSelection();
  const L = picked ? picked.L : line(ui.row);
  const o = originOf(L);
  const turn = o ? { turn: o.step.turn, trajectory: S.trName, line: o.step.line, inferred: o.inferred } : null;
  const text = patchLineReference(S.patchName, L, picked?.sel, turn);
  const short = text.split("\n")[0].replace(/^Reference: /, "");
  post({ type: "copy", text, label: "reference to patch row " + L.row });
  (window as unknown as { __lastLineRef?: string }).__lastLineRef = text;
  toast("Reference copied: <code>" + esc(short) + "</code>" + (picked ? " + the selected text" : " + the line"));
}
$("#copy-line-ref").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
$("#copy-line-ref").addEventListener("click", copyLineReference);
function renderRows(force = false): void {
  if (!S.pm) return;
  const n = S.pm.lines.length;
  const first = Math.max(0, Math.floor(editor.scrollTop / ROW_H) - 40);
  const last = Math.min(n, Math.ceil((editor.scrollTop + editor.clientHeight) / ROW_H) + 40);
  if (!force && first === rendered.first && last === rendered.last) return;
  rendered = { first, last };
  const rows = $("#rows");
  rows.style.transform = "translateY(" + first * ROW_H + "px)";
  let html = "";
  for (let i = first; i < last; i++) html += lineHTML(S.pm.lines[i]);
  rows.innerHTML = html;
  updateStickyTurn();
}
/**
 * Moves the cursor and the "same turn" highlight on the rows already in the DOM.
 * Rebuilding them would replace the text under the mouse and break double-click word selection.
 */
function markRows(): void {
  if (!S.pm) return;
  const run = originOf(line(ui.row))?.step;
  document.querySelectorAll<HTMLElement>("#rows .ln").forEach((el) => {
    const L = line(+el.dataset.row!);
    el.classList.toggle("cur", L.row === ui.row);
    el.classList.toggle("linkrun", !!run && originOf(L)?.step === run);
  });
}
function setupSpacer(): void {
  if (!S.pm) return;
  const maxLen = S.pm.lines.reduce((m, L) => Math.max(m, L.text.length), 0);
  const sp = $("#spacer");
  sp.style.height = S.pm.lines.length * ROW_H + "px";
  sp.style.width = "calc(" + Math.min(maxLen, 2000) + "ch + 200px)";
}
editor.addEventListener("scroll", () => { renderRows(); updateStickyTurn(); }, { passive: true });

// ---------------------------------------------------------------- sticky turn chip
// A turn chip only sits on the first row of a run of +/- lines written by the same step.
// While the run continues below the top edge, the chip stays pinned at the top of the patch;
// the last row of the run pushes it up as it scrolls away.
const sameRun = (a: PatchLine, b: PatchLine) =>
  (a.kind === "add" || a.kind === "del") && (b.kind === "add" || b.kind === "del") && !!originOf(a) && originOf(a)?.step === originOf(b)?.step;
/** Patch row of the pinned run start, and the cache key of what the chip shows. */
let stickyRow = 0, stickyKey = "";
function updateStickyTurn(): void {
  const el = $("#sticky-turn");
  const hide = () => { el.hidden = true; stickyRow = 0; };
  if (!S.pm || !S.links || ui.hiddenCols.includes("turn") || !S.pm.lines.length) return hide();
  const n = S.pm.lines.length;
  const top = Math.min(n, Math.floor(editor.scrollTop / ROW_H) + 1);
  const T = line(top), o = originOf(T);
  if (!o || (T.kind !== "add" && T.kind !== "del")) return hide();
  let start = top;
  while (start > 1 && sameRun(line(start - 1), T)) start--;
  // the real chip is fully visible: nothing to pin
  if ((start - 1) * ROW_H >= editor.scrollTop) return hide();
  let end = top;
  while (end < n && sameRun(line(end + 1), T)) end++;
  const gb = document.querySelector<HTMLElement>("#rows .g-blame");
  if (!gb) return hide();
  const wrap = el.parentElement!.getBoundingClientRect();
  const left = gb.getBoundingClientRect().left - wrap.left;
  if (left < 0) return hide();
  const so = originOf(line(start)) ?? o;
  const c = turnColor(so.step.turn ?? 0);
  stickyRow = start;
  const key = start + ":" + so.step.line + ":" + so.inferred;
  if (stickyKey !== key) {
    stickyKey = key;
    el.innerHTML = '<span class="g-blame"><span class="bar" style="background:' + c + '"></span><span class="chip' + (so.inferred ? " inf" : "") +
      '" style="background:' + c + '" title="Written in agent turn ' + so.step.turn + " (line " + so.step.line + " of the trajectory) · rows " + start + "-" + end + ' of the patch">T' + so.step.turn + "</span></span>";
  }
  el.style.left = left + "px";
  el.style.top = Math.min(0, end * ROW_H - editor.scrollTop - ROW_H) + "px";
  el.hidden = false;
}
$("#sticky-turn").addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !stickyRow) return;
  e.preventDefault();
  const L = line(stickyRow), o = originOf(L);
  if (o) { if (!ui.showTraj) toggle("traj", true); Table.reveal(o.step, L); }
});
new ResizeObserver(() => renderRows()).observe(editor);

function revealRow(r: number, center = false): void {
  const top = (r - 1) * ROW_H;
  if (center) editor.scrollTop = top - editor.clientHeight / 2 + ROW_H / 2;
  else if (top < editor.scrollTop) editor.scrollTop = top;
  else if (top + ROW_H > editor.scrollTop + editor.clientHeight) editor.scrollTop = top + ROW_H - editor.clientHeight;
  renderRows();
}
function setRow(r: number, opts: { center?: boolean; fromTraj?: boolean } = {}): void {
  if (!S.pm || !S.pm.lines.length) return;
  r = Math.max(1, Math.min(S.pm.lines.length, r));
  ui.row = r;
  persist();
  if (ui.showPatch) revealRow(r, opts.center);
  markRows();
  updateCursorPos();
  updatePatchPanels(opts);
}
function hunkNav(dir: number): void {
  if (!S.pm) return;
  const all: Hunk[] = [];
  S.pm.files.forEach((f) => f.hunks.forEach((h) => all.push(h)));
  if (!all.length) return;
  let t: Hunk;
  if (dir > 0) t = all.find((h) => h.startRow > ui.row) || all[all.length - 1];
  else { const prev = all.filter((h) => h.startRow < ui.row); t = prev.length ? prev[prev.length - 1] : all[0]; }
  setRow(t.startRow + 1, { center: true });
}
editor.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  const chip = target.closest<HTMLElement>("[data-blame]");
  if (chip) {
    e.preventDefault();
    const L = line(+chip.dataset.blame!);
    setRow(L.row);
    const o = originOf(L);
    if (o) { if (!ui.showTraj) toggle("traj", true); Table.reveal(o.step, L); }
    return;
  }
  const ln = target.closest<HTMLElement>(".ln");
  if (ln) setRow(+ln.dataset.row!);
});
editor.addEventListener("keydown", (e) => {
  if (!S.pm) return;
  if (e.ctrlKey && e.key === "Home") { e.preventDefault(); setRow(1); return; }
  if (e.ctrlKey && e.key === "End") { e.preventDefault(); setRow(S.pm.lines.length); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const page = Math.max(1, Math.floor(editor.clientHeight / ROW_H) - 2);
  const map: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
  if (map[e.key] != null) { e.preventDefault(); setRow(ui.row + map[e.key]); }
  else if (e.key === "n" || e.key === "N") { e.preventDefault(); hunkNav(e.shiftKey ? -1 : 1); }
  else if (e.key === "p" || e.key === "P") { e.preventDefault(); hunkNav(-1); }
  else if (e.key === "d" || e.key === "D") { e.preventDefault(); toggleDetails(); }
});
$(".pp-title .nav").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-nav]");
  if (b) hunkNav(+b.dataset.nav!);
});
$("#sbs").addEventListener("mousedown", (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>(".sbs-row");
  if (r && e.button === 0) { e.preventDefault(); setRow(+r.dataset.row!); }
});

// ---------------------------------------------------------------- patch side panels
function refFor(L: PatchLine): string | null {
  const d = describe(L);
  if (!d.path) return null;
  return d.primary ? d.path + ":" + d.primary.line : d.path;
}
function updatePatchPanels(opts: { fromTraj?: boolean } = {}): void {
  if (!S.pm) return;
  const L = line(ui.row), d = describe(L);
  const o = originOf(L);
  const crumb = [esc(S.patchName)];
  if (L.file) crumb.push(esc(L.file.path));
  if (L.hunk && L.file) crumb.push("@@ hunk " + (L.hunk.index + 1) + "/" + L.file.hunks.length);
  $("#crumb").innerHTML = crumb.join('<span class="sep">›</span>');

  const num = (cls: string, label: string, val: string | number | null) =>
    '<div class="pc-num ' + cls + (val == null ? " dim" : "") + '"><label>' + label + "</label><b>" + (val == null ? "—" : esc(val)) + "</b></div>";
  let oldV: string | number | null = L.old, newV: string | number | null = L.new;
  if (L.kind === "hunk" && L.hunk) { oldV = rangeText(L.hunk.oldStart, L.hunk.oldCount); newV = rangeText(L.hunk.newStart, L.hunk.newCount); }
  const ref = refFor(L);
  $("#pos-card").innerHTML =
    '<div class="pc-path">' + esc(d.path || "(row outside any file)") + (L.hunk && L.file ? ' <span class="muted">· hunk ' + (L.hunk.index + 1) + "/" + L.file.hunks.length + "</span>" : "") + "</div>" +
    '<div class="pc-nums">' + num("patch", "Patch row", L.row) + num("old", "Original (a/)", oldV) + num("new", "New (b/)", newV) + "</div>" +
    '<div class="pc-hint">' + esc(d.hint) + "</div>" +
    '<div class="pc-actions"><button class="btn primary" data-act="open"' + (d.path && d.primary ? "" : " disabled") + ">Open file at this line</button>" +
    '<button class="btn" data-act="copy"' + (ref ? "" : " disabled") + ">Copy " + esc(ref ? baseName(ref) : "path:line") + "</button></div>";

  // side by side
  const sbs = $("#sbs"), h = L.hunk;
  if (!h) {
    S.sbsHunk = null;
    $("#sbs-title").textContent = "Hunk side by side";
    sbs.innerHTML = '<div class="empty-note">File header. Move to a hunk (<kbd>N</kbd>).</div>';
  } else {
    if (S.sbsHunk !== h) {
      S.sbsHunk = h;
      $("#sbs-title").textContent = baseName(h.file.path) + " · hunk " + (h.index + 1) + "/" + h.file.hunks.length;
      sbs.innerHTML = sideBySide(h).map((p) => {
        const l = p.left, r = p.right;
        const rowRef = r && r.kind === "add" ? r.row : l ? l.row : r!.row;
        return '<div class="sbs-row" data-row="' + rowRef + '" data-rows="' + [l && l.row, r && r.row].filter(Boolean).join(" ") + '">' +
          '<div class="num l-n">' + (l ? l.old : "") + '</div><div class="l ' + (l ? (l.kind === "del" ? "del" : "") : "empty") + '">' + (l ? esc(l.text.slice(1)) : "") + "</div>" +
          '<div class="num r-n">' + (r ? r.new : "") + '</div><div class="r ' + (r ? (r.kind === "add" ? "add" : "") : "empty") + '">' + (r ? esc(r.text.slice(1)) : "") + "</div></div>";
      }).join("");
      sbs.scrollTop = 0;
    }
    sbs.querySelector(".sbs-row.cur")?.classList.remove("cur");
    const cur = Array.from(sbs.querySelectorAll<HTMLElement>(".sbs-row")).find((x) => x.dataset.rows!.split(" ").includes(String(L.row)));
    if (cur) {
      cur.classList.add("cur");
      const tt = cur.offsetTop - sbs.offsetTop;
      if (tt < sbs.scrollTop || tt + 18 > sbs.scrollTop + sbs.clientHeight) sbs.scrollTop = tt - sbs.clientHeight / 3;
    }
  }

  renderWhy(L);
  post({
    type: "cursor",
    info: {
      row: L.row, path: d.path, kind: L.kind, old: L.old, new: L.new,
      hunkOld: L.hunk ? L.hunk.oldStart : null, hunkNew: L.hunk ? L.hunk.newStart : null,
      turn: o ? o.step.turn : null,
    },
  });
  if (S.tr && !opts.fromTraj) Table.onPatchCursor(L);
}
$("#pos-card").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!b || b.disabled || !S.pm) return;
  const L = line(ui.row), d = describe(L);
  if (b.dataset.act === "open" && d.path && d.primary) {
    const lineNo = d.primary.side === "old" ? (L.newAnchor ?? d.primary.line) : d.primary.line;
    post({ type: "openFile", path: d.path, line: lineNo, side: d.primary.side });
  }
  if (b.dataset.act === "copy") { const ref = refFor(L); if (ref) post({ type: "copy", text: ref, label: ref }); }
});

// "Why this line exists"
function renderWhy(L: PatchLine): void {
  const box = $("#link-box");
  const followBox = '<label class="follow"><input type="checkbox" id="follow-chk"' + (ui.follow ? " checked" : "") + "> follow cursor</label>";
  if (!S.tr) {
    box.innerHTML = '<h4><span>Why this line exists</span></h4><div class="muted">' +
      (S.loadingName ? "Loading " + esc(S.loadingName) + "…" : 'No trajectory associated. <a data-lk="open">Associate a .jsonl…</a>') + "</div>";
    return;
  }
  const o = originOf(L);
  let html = "<h4><span>Why this line exists</span>" + followBox + "</h4>";
  if (!o) {
    html += '<div class="muted">' + (L.kind === "add" || L.kind === "del"
      ? "No command in the trajectory contains this line."
      : "Put the cursor on a + or − line to see the agent turn that wrote it, and why.") + "</div>";
    box.innerHTML = html;
    return;
  }
  const s = o.step, turn = s.turn != null ? S.tr.turns.get(s.turn) : undefined;
  const verb = L.kind === "del" ? "replaced or removed in" : "written in";
  const pos = locateInCommand(L, s);
  const t = L.text.slice(1).trim();
  let cmdHTML: string;
  if (pos >= 0 && s.command) {
    const a = Math.max(0, s.command.lastIndexOf("\n", Math.max(0, pos - 260)) + 1);
    const b = Math.min(s.command.length, pos + t.length + 320);
    cmdHTML = (a > 0 ? "…\n" : "") + hl(s.command.slice(a, b), [{ a: pos - a, b: pos - a + t.length, cls: "origin" }]) + (b < s.command.length ? "\n…" : "");
  } else cmdHTML = hl(clip(s.command, 600));
  html += '<div class="why-card"><div><span class="pill" style="background:' + turnColor(s.turn ?? 0) + '">T' + s.turn + "</span> " + verb + " turn " + s.turn +
    " · line " + s.line + " of the trajectory" + (o.inferred ? ' <span class="muted">(inherited from the neighbouring line)</span>' : "") +
    (o.candidates > 1 ? ' <span class="muted">(text found in ' + o.candidates + " write commands; showing the first)</span>" : "") +
    ' · <a data-lk="reveal">show in table</a></div>' +
    (turn && turn.text ? '<div class="turn-text">“' + hl(clip(turn.text, 700)) + "”</div>" : "") +
    (turn && turn.thought ? "<details><summary>Agent reasoning (" + turn.thought.length + ' characters)</summary><div class="thought">' + hl(clip(turn.thought, 4000)) + "</div></details>" : "") +
    "<pre>" + cmdHTML + "</pre></div>";
  box.innerHTML = html;
}
$("#link-box").addEventListener("click", (e) => {
  const lk = (e.target as HTMLElement).closest<HTMLElement>("[data-lk]");
  if (!lk || !S.pm) return;
  if (lk.dataset.lk === "open") post({ type: "pickTrajectory" });
  if (lk.dataset.lk === "reveal") {
    const L = line(ui.row), o = originOf(L);
    if (o) { if (!ui.showTraj) toggle("traj", true); Table.reveal(o.step, L); }
  }
});
$("#link-box").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "follow-chk") { ui.follow = t.checked; persist(); if (ui.follow && S.pm) Table.onPatchCursor(line(ui.row)); }
});

// ---------------------------------------------------------------- trajectory: table + detail
/** Characters of a field rendered in the step detail (outputs can be several MB). */
const DETAIL_CLIP = 200_000;
function jumpPatchToStep(s: Step): void {
  if (!s.patchRows.length) { toast("This step did not write any patch line."); return; }
  if (!ui.showPatch) toggle("patch", true);
  // With an active search, prefer the first line written by this step that contains the query.
  const rows = new Set(s.patchRows);
  const m = S.q ? S.pMatches.findIndex((x) => rows.has(x.row)) : -1;
  if (m === -1) { setRow(s.patchRows[0], { center: true, fromTraj: true }); return; }
  S.pCur = m;
  setRow(S.pMatches[m].row, { center: true, fromTraj: true });
  renderRows(true);
  updateFindWidgets();
}
function summaryHTML(): string {
  const tr = S.tr!, m = tr.manifest as Record<string, unknown> | null, v = tr.verdict as Record<string, unknown> | null;
  const writes = tr.steps.filter((s) => s.patchRows.length).length;
  const st = S.links!.stats;
  const parts: string[] = [];
  if (m) {
    if (m.task_title) parts.push("<b>" + esc(m.task_title) + "</b>");
    if (m.model) parts.push(esc(m.model));
    if (m.scaffold) parts.push(esc(m.scaffold));
  }
  if (v) parts.push(v.pass ? '<span class="pill ok">verdict PASS</span>' : '<span class="pill fail">verdict FAIL</span>');
  parts.push('<span class="muted" title="Trajectory schema, detected from the file">' + esc(tr.schema.label) + "</span>");
  parts.push(tr.turns.size + " turns · " + tr.steps.length + " lines" + (tr.bad ? " · " + tr.bad + " unreadable" : ""));
  const timings = m && (m.timings as Record<string, unknown> | undefined);
  if (timings && typeof timings.total_s === "number") parts.push(timings.total_s < 90 ? Math.round(timings.total_s) + " s" : Math.round(timings.total_s / 60) + " min");
  parts.push('<span class="pill w">✎ ' + writes + " steps wrote " + st.linked + "/" + st.lines + " +/− lines</span>");
  return '<div class="traj-summary">' + parts.map((p) => "<span>" + p + "</span>").join("") + "</div>";
}

const Table = {
  sel: null as Step | null,
  linked: null as Step | null,
  linkL: null as PatchLine | null,
  matches: [] as Step[],
  cur: -1,
  total: 0,
  box: null as HTMLElement | null,

  mount(): void {
    const c = $("#traj-view");
    this.sel = null; this.linked = null; this.linkL = null;
    const filters: [Filter, string][] = [["all", "All"], ["model", "Model"], ["cmd", "Commands"], ["write", "Wrote the patch"], ["hits", "With matches"]];
    c.innerHTML = summaryHTML() +
      '<div class="tbl-tools"><span class="muted">Show:</span>' + filters.map(([k, l]) => '<button data-f="' + k + '"' + (k === ui.filter ? ' class="on"' : "") + ">" + l + "</button>").join("") + "</div>" +
      '<div class="tbl-wrap"><div class="tbl" id="tbl"></div><div class="detail" id="detail"></div></div>';
    this.box = $("#tbl");
    $(".tbl-tools", c).addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-f]");
      if (!b) return;
      ui.filter = b.dataset.f as Filter; persist();
      c.querySelectorAll(".tbl-tools button").forEach((x) => x.classList.toggle("on", x === b));
      this.render();
    });
    this.box.addEventListener("click", (e) => {
      const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-idx]");
      if (!tr) return;
      const s = S.tr!.steps[+tr.dataset.idx!];
      this.select(s);
      if ((e.target as HTMLElement).closest("[data-w]")) jumpPatchToStep(s);
    });
    this.search();
  },
  hits(s: Step): number { if (!S.q) return 0; let n = 0; for (const f of fields(s)) n += countAll(f.value); return n; },
  summary(s: Step): string {
    if (s.role === "model") return s.text || (s.thought || "").split("\n")[0];
    if (s.role === "cmd") return (s.command || "").split("\n")[0];
    if (s.role === "manifest") { const m = S.tr!.manifest!; return [m.task_title, m.model, m.status].filter(Boolean).join(" · "); }
    if (s.role === "verdict") return (s.output || "").split("\n")[0];
    if (s.role === "bad") return "(unreadable JSON line)";
    return (s.event || "") + (s.step ? " · " + s.step : "") + (s.output ? " · " + s.output.split("\n")[0] : "");
  },
  visible(s: Step): boolean {
    switch (ui.filter) {
      case "model": return s.role === "model";
      case "cmd": return s.role === "cmd";
      case "write": return s.patchRows.length > 0;
      case "hits": return this.hits(s) > 0;
      default: return true;
    }
  },
  rowHTML(s: Step): string {
    const h = this.hits(s);
    return '<tr data-idx="' + s.index + '" class="' + (this.sel === s ? "sel " : "") + (this.linked === s ? "linked" : "") + '">' +
      "<td>" + s.line + "</td><td>" + (s.seq ?? "") + "</td><td>" + (s.turn != null ? '<span class="tag" style="background:' + turnColor(s.turn) + ';color:#111">T' + s.turn + "</span>" : "") + "</td>" +
      '<td><span class="tag r-' + s.role + '">' + s.role + "</span></td>" +
      '<td class="sum">' + hl(clip(this.summary(s), 220)) + "</td><td>" + (s.exit ?? "") + "</td><td>" + fmtMs(s.latencyMs) + "</td>" +
      "<td>" + (s.patchRows.length ? '<span class="wchip" data-w="1" title="Go to the first patch line written by this step (the first one with the search text, if any)">✎ ' + s.patchRows.length + "</span>" : "") +
      (h ? ' <span class="hitchip">⌕ ' + h + "</span>" : "") + "</td></tr>";
  },
  render(): void {
    if (!this.box || !S.tr) return;
    const st = this.box.scrollTop;
    const rows = S.tr.steps.filter((s) => this.visible(s));
    this.box.innerHTML = '<table><colgroup><col style="width:52px"><col style="width:48px"><col style="width:52px"><col style="width:76px"><col><col style="width:40px"><col style="width:58px"><col style="width:100px"></colgroup>' +
      "<thead><tr><th>Line</th><th>seq</th><th>Turn</th><th>Type</th><th>Summary</th><th>exit</th><th>Δt</th><th>Patch</th></tr></thead><tbody>" +
      rows.map((s) => this.rowHTML(s)).join("") + "</tbody></table>";
    this.box.scrollTop = st;
    this.renderDetail();
  },
  renderRow(s: Step): void {
    const el = this.box?.querySelector('tr[data-idx="' + s.index + '"]');
    if (el) el.outerHTML = this.rowHTML(s);
  },
  renderDetail(): void {
    const d = $("#detail"), s = this.sel;
    if (!d) return;
    if (!s) { d.innerHTML = '<div class="empty-note">Pick a row (or a <b>T·</b> chip in the patch) to see the full step.</div>'; updateRefButton(); return; }
    let html = '<div class="detail-bar"><span><b>Line ' + s.line + "</b> · " + esc(stepLabel(s)) + (s.seq != null ? " · seq " + s.seq : "") + (s.exit != null ? " · exit " + s.exit : "") +
      (s.patchRows.length ? ' · <span class="wchip" data-dw="1">✎ ' + s.patchRows.length + " patch lines</span>" : "") + "</span>" +
      '<span class="ref"><span id="ref-info">Select text to reference it</span>' +
      '<button class="btn primary" id="ref-btn" disabled title="Select text inside one field">⧉ Copy reference</button></span></div>';
    for (const f of fields(s)) {
      const shown = clip(f.value, DETAIL_CLIP);
      const extra: Range[] = [];
      if (f.name === "command" && this.linkL && this.linked === s) {
        const t = this.linkL.text.slice(1).trim(), i = shown.indexOf(t);
        if (t && i >= 0) extra.push({ a: i, b: i + t.length, cls: "origin" });
      }
      html += "<h5>" + esc(fieldPath(s, f.name)) + " · " + f.value.length + ' characters</h5><pre data-field="' + f.name + '">' + hl(shown, extra) + "</pre>" +
        (shown.length < f.value.length ? '<div class="empty-note">Showing the first ' + DETAIL_CLIP.toLocaleString("en-US") + " characters of " + f.value.length.toLocaleString("en-US") + ".</div>" : "");
    }
    d.innerHTML = html;
    const mk = d.querySelector<HTMLElement>("mark.origin") || d.querySelector<HTMLElement>("mark.cur") || d.querySelector<HTMLElement>("mark.m");
    if (mk) {
      const pre = mk.closest("pre")!;
      pre.scrollTop = mk.offsetTop - pre.offsetTop - 40;
      d.scrollTop = pre.offsetTop - d.offsetTop - 70;
    } else d.scrollTop = 0;
    updateRefButton();
  },
  select(s: Step, scroll = false): void {
    const prev = this.sel;
    this.sel = s;
    if (prev) this.renderRow(prev);
    if (!this.visible(s)) {
      ui.filter = "all"; persist();
      document.querySelectorAll<HTMLElement>(".tbl-tools button").forEach((x) => x.classList.toggle("on", x.dataset.f === "all"));
      this.render();
    } else this.renderRow(s);
    const el = this.box?.querySelector<HTMLElement>('tr[data-idx="' + s.index + '"]');
    if (scroll && el && this.box) this.box.scrollTop = el.offsetTop - this.box.clientHeight / 3;
    this.renderDetail();
  },
  search(): number {
    this.matches = S.q && S.tr ? S.tr.steps.filter((s) => this.hits(s) > 0) : [];
    this.total = this.matches.reduce((a, s) => a + this.hits(s), 0);
    this.cur = -1;
    this.render();
    return this.total;
  },
  next(dir: number): void {
    if (!this.matches.length) return;
    this.cur = (this.cur + dir + this.matches.length) % this.matches.length;
    this.select(this.matches[this.cur], true);
  },
  reveal(s: Step, L: PatchLine | null): void {
    const prev = this.linked;
    this.linked = s; this.linkL = L;
    if (prev && prev !== s) this.renderRow(prev);
    this.select(s, true);
  },
  onPatchCursor(L: PatchLine): void {
    const o = originOf(L);
    if (o && ui.follow && ui.showTraj) this.reveal(o.step, L);
    else if (this.linked && !o) { const p = this.linked; this.linked = null; this.linkL = null; this.renderRow(p); }
  },
};
$("#traj-view").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-dw]") && Table.sel) jumpPatchToStep(Table.sel);
  if (t.closest("#open-traj")) post({ type: "pickTrajectory" });
  const sib = t.closest<HTMLElement>("[data-sib]");
  if (sib) post({ type: "loadSibling", name: sib.dataset.sib! });
  if (t.closest("#ref-btn")) copyReference();
});

// ---------------------------------------------------------------- exact references to selected text
interface SelectionRef { ref: TextReference; step: Step; path: string }
function selectionRef(): SelectionRef | { error: string } | null {
  if (!Table.sel || !S.tr) return null;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const preOf = (n: Node) => ((n.nodeType === 1 ? n : n.parentElement) as HTMLElement | null)?.closest<HTMLElement>("#detail pre[data-field]") ?? null;
  const a = preOf(r.startContainer), b = preOf(r.endContainer);
  if (!a && !b) return null;
  if (a !== b || !a) return { error: "Select inside a single field" };
  const head = document.createRange();
  head.selectNodeContents(a);
  head.setEnd(r.startContainer, r.startOffset);
  const start = head.toString().length, text = r.toString();
  const s = Table.sel, f = fields(s).find((x) => x.name === a.dataset.field);
  if (!f) return { error: "Unknown field" };
  const path = fieldPath(s, f.name);
  const ref = makeReference(S.trName, s.line, path, f.value, start, text);
  return ref ? { ref, step: s, path } : { error: "Could not locate the text in the field" };
}
function updateRefButton(): void {
  const btn = document.getElementById("ref-btn") as HTMLButtonElement | null, info = document.getElementById("ref-info");
  if (!btn || !info) return;
  const r = selectionRef();
  const ok = r && !("error" in r) ? r : null;
  btn.disabled = !ok;
  btn.title = ok ? "Copy " + ok.ref.short + " and the text" : (r && "error" in r ? r.error : "Select text inside one field");
  info.textContent = ok ? ok.path + " › " + ok.ref.loc + " · " + ok.ref.text.length + " characters" : (r && "error" in r ? r.error : "Select text to reference it");
  info.classList.toggle("err", !!(r && "error" in r));
}
function copyReference(): void {
  const r = selectionRef();
  if (!r || "error" in r || !S.tr) return;
  const m = S.tr.manifest;
  const step = stepLabel(r.step) + (r.step.seq != null ? " · seq " + r.step.seq : "") + (m && m.run_id ? " · run " + String(m.run_id) : "");
  post({ type: "copy", text: referenceText(r.ref, step, r.path), label: "reference " + r.ref.short });
  toast("Reference copied: <code>" + esc(r.ref.short) + "</code> + the text (" + r.ref.text.length + " characters)");
}
document.addEventListener("selectionchange", updateRefButton);
// keep the text selection alive when pressing the button
$("#traj-view").addEventListener("mousedown", (e) => { if ((e.target as HTMLElement).closest("#ref-btn")) e.preventDefault(); });

// ---------------------------------------------------------------- trajectory pane states
function renderTrajectoryPane(): void {
  const c = $("#traj-view");
  if (S.tr) {
    $("#traj-name").innerHTML = esc(S.trName) + (S.trSource === "default" ? ' <span class="muted">(default)</span>' : "");
    Table.mount();
  } else if (S.loadingName) {
    $("#traj-name").textContent = S.loadingName;
    c.innerHTML = '<div class="traj-empty"><h3>Loading ' + esc(S.loadingName) + "…</h3></div>";
  } else {
    $("#traj-name").textContent = "trajectory · none associated";
    const m = S.missing;
    const sibs = (m?.siblings || []).filter((x) => x.name !== baseName(m?.expected));
    c.innerHTML = '<div class="traj-empty">' +
      "<h3>No trajectory found for this patch</h3>" +
      (m?.error ? '<p class="err">' + esc(m.error) + "</p>" : "") +
      "<p>Looked for <code>" + esc(m?.expected || S.expectedTrajectory) + "</code>.</p>" +
      '<button class="btn primary" id="open-traj">Open trajectory…</button>' +
      (sibs.length ? '<div class="sugg"><div class="muted">Other .jsonl files in the same folder:</div>' +
        sibs.map((x) => '<button data-sib="' + esc(x.name) + '">' + esc(x.name) + ' <span class="muted">· ' + (x.size / 1048576).toFixed(1) + " MB</span></button>").join("") + "</div>" : "") +
      "</div>";
  }
  applyLayout();
}

function onPatchText(text: string): void {
  S.pm = parsePatch(text);
  S.sbsHunk = null;
  if (S.tr) S.links = link(S.pm, S.tr);
  if (ui.row > S.pm.lines.length) ui.row = 1;
  setupSpacer();
  if (S.findOpen) runSearch(); else renderRows(true);
  if (S.tr) Table.mount();
  setRow(ui.row, { center: true });
}
function onTrajectory(text: string, name: string, source: TrajectorySource): void {
  S.tr = parseTrajectory(text);
  S.trName = name; S.trSource = source; S.missing = null; S.loadingName = "";
  if (S.pm) S.links = link(S.pm, S.tr);
  renderTrajectoryPane();
  if (S.findOpen) runSearch();
  if (S.pm) setRow(ui.row, { center: true });
}

// ---------------------------------------------------------------- cross find (Ctrl+F)
function findHTML(side: string): string {
  return '<input type="text" placeholder="Find in patch and trajectory" spellcheck="false" data-side="' + side + '">' +
    '<button class="aa" title="Match case">Aa</button><span class="cnt"></span><span class="other"></span>' +
    '<button class="ic" data-dir="-1" title="Previous match (Shift+Enter)">↑</button><button class="ic" data-dir="1" title="Next match (Enter)">↓</button><button class="ic" data-close="1" title="Close (Escape)">✕</button>';
}
let findTimer = 0;
(["patch", "traj"] as const).forEach((side) => {
  const w = $("#find-" + side);
  w.innerHTML = findHTML(side);
  const inp = $<HTMLInputElement>("input", w);
  inp.addEventListener("input", () => { S.q = inp.value; syncInputs(side); clearTimeout(findTimer); findTimer = window.setTimeout(runSearch, 140); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); clearTimeout(findTimer); if (S.qDone !== S.q + "|" + S.cs) runSearch(); findNext(side, e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
  });
  inp.addEventListener("focus", () => setFocus(side));
  $(".aa", w).addEventListener("click", () => { S.cs = !S.cs; document.querySelectorAll(".find .aa").forEach((b) => b.classList.toggle("on", S.cs)); runSearch(); });
  w.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("button[data-dir]");
    if (b) findNext(side, +b.dataset.dir!);
    if (t.closest("[data-close]")) closeFind();
  });
});
function syncInputs(from: string | null): void {
  document.querySelectorAll<HTMLInputElement>(".find input").forEach((i) => { if (i.dataset.side !== from) i.value = S.q; });
}
function runSearch(): void {
  S.qDone = S.q + "|" + S.cs;
  syncInputs((document.activeElement as HTMLElement | null)?.dataset?.side ?? null);
  S.pMatches = []; S.pCur = -1;
  if (S.q && S.pm) for (const L of S.pm.lines) for (const i of findAll(L.text, S.q, S.cs, 200)) S.pMatches.push({ row: L.row, idx: i });
  renderRows(true);
  if (S.tr) Table.search();
  if (S.pm) renderWhy(line(ui.row));
  updateFindWidgets();
}
function findNext(side: "patch" | "traj", dir: number): void {
  if (side === "patch" || !S.tr) {
    if (!S.pMatches.length) return;
    if (S.pCur === -1) {
      const i = S.pMatches.findIndex((m) => m.row >= ui.row);
      S.pCur = dir > 0 ? (i === -1 ? 0 : i) : i <= 0 ? S.pMatches.length - 1 : i - 1;
    } else S.pCur = (S.pCur + dir + S.pMatches.length) % S.pMatches.length;
    setRow(S.pMatches[S.pCur].row, { center: true });
  } else Table.next(dir);
  updateFindWidgets();
}
function updateFindWidgets(): void {
  const pTotal = S.pMatches.length;
  const fmt = (cur: number, total: number) => (!S.q ? "" : total ? (cur >= 0 ? cur + 1 + " of " + total : total + " results") : "No results");
  const wp = $("#find-patch"), wt = $("#find-traj");
  wp.classList.toggle("on", S.findOpen && ui.showPatch);
  wt.classList.toggle("on", S.findOpen && ui.showTraj && !!S.tr);
  const pc = $(".cnt", wp);
  pc.textContent = fmt(S.pCur, pTotal);
  pc.classList.toggle("zero", !!S.q && !pTotal);
  $(".other", wp).textContent = S.q && S.tr ? "↔ trajectory: " + Table.total : "";
  const tc = $(".cnt", wt);
  tc.textContent = !S.q ? "" : Table.total ? (Table.cur >= 0 ? "step " + (Table.cur + 1) + "/" + Table.matches.length : Table.total + " in " + Table.matches.length + " steps") : "No results";
  tc.classList.toggle("zero", !!S.q && !Table.total);
  $(".other", wt).textContent = S.q ? "↔ patch: " + pTotal : "";
}
function openFind(): void {
  S.findOpen = true;
  const sel = String(window.getSelection() || "").trim();
  if (sel && sel.length < 200 && !sel.includes("\n")) S.q = sel;
  updateFindWidgets();
  const side = S.focus === "traj" && ui.showTraj && S.tr ? "traj" : ui.showPatch ? "patch" : "traj";
  const inp = $<HTMLInputElement>("#find-" + side + " input");
  inp.value = S.q;
  inp.focus();
  inp.select();
  runSearch();
}
function closeFind(): void {
  S.findOpen = false;
  S.q = "";
  runSearch();
  if (S.focus === "patch") editor.focus({ preventScroll: true });
}
// Ctrl+F also arrives as the patchTrail.find command; handling it here keeps it inside the webview.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") { e.preventDefault(); e.stopPropagation(); openFind(); }
  else if (e.key === "F3") { e.preventDefault(); if (!S.findOpen) openFind(); else findNext(S.focus, e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape" && S.findOpen && !(e.target as HTMLElement).closest?.(".find")) closeFind();
});

// ---------------------------------------------------------------- host messages
window.addEventListener("message", (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "patch":
      S.patchName = m.name;
      S.expectedTrajectory = m.expectedTrajectory;
      onPatchText(m.text);
      applyLayout();
      break;
    case "trajectoryLoading":
      S.loadingName = m.name;
      renderTrajectoryPane();
      break;
    case "trajectory":
      onTrajectory(m.text, m.name, m.source);
      break;
    case "trajectoryMissing":
      S.tr = null; S.links = null; S.trName = ""; S.loadingName = "";
      S.missing = { expected: m.expected, siblings: m.siblings, error: m.error };
      renderTrajectoryPane();
      if (S.pm) setRow(ui.row);
      break;
    case "find":
      openFind();
      break;
    case "toggle":
      if (m.pane === "details") toggleDetails(m.visible);
      else toggle(m.pane === "patch" ? "patch" : "traj", m.visible);
      break;
  }
});

setFocus("patch");
renderColbar();
applyLayout();
renderTrajectoryPane();
post({ type: "ready" });
