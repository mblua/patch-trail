// Coding-agent trajectory (.jsonl) parser and linker: finds, for every +/- line
// of a patch, the trajectory step whose command wrote it.

import type { PatchFile, PatchLine, PatchModel } from "./patch";

export type StepRole = "manifest" | "verdict" | "model" | "cmd" | "event" | "bad";

export interface Step {
  /** 1-based line in the .jsonl file. */
  line: number;
  raw: string;
  role: StepRole;
  type: string | null;
  kind: string | null;
  seq: number | null;
  step: string | null;
  /** Agent turn N, from step names like "model:N" / "model:N:bash". */
  turn: number | null;
  event: string | null;
  text: string | null;
  thought: string | null;
  command: string | null;
  output: string | null;
  stderr: string | null;
  exit: number | null;
  tokIn: number | null;
  tokOut: number | null;
  latencyMs: number | null;
  payload: Record<string, unknown>;
  /** Parsed top-level object (manifest / verdict). */
  obj: Record<string, unknown> | null;
  isWrite: boolean;
  /** Patch files whose path appears in this step's command. */
  files: PatchFile[];
  /** Patch files this step wrote. */
  writesFiles: PatchFile[];
  /** Patch rows whose origin is this step. */
  patchRows: number[];
}

export interface Turn { turn: number; model: Step; cmds: Step[] }

export interface Trajectory {
  steps: Step[];
  turns: Map<number, Turn>;
  manifest: Record<string, unknown> | null;
  verdict: Record<string, unknown> | null;
  bad: number;
}

/** Commands that write files: python open(path, "w"), sed -i, cat > file, tee, git apply, ... */
export const WRITE_RE =
  /sed\s+-i|open\([^)]*?["']w["']|\.write_text\(|perl\s+-p?i|git\s+apply|patch\s+-p\d|cat\s*>|cat\s+<<[^\n]*>|\btee\b|>\s*[\w./-]+\.(rs|json|toml|md|py|js|ts|tsx|jsx|go|java|c|h|cpp|yaml|yml|txt)\b/;

const str = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function parseTrajectory(text: string): Trajectory {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const steps: Step[] = [];
  const turns = new Map<number, Turn>();
  let manifest: Record<string, unknown> | null = null;
  let verdict: Record<string, unknown> | null = null;
  let bad = 0;

  lines.forEach((raw, i) => {
    const s: Step = {
      line: i + 1, raw, role: "event", type: null, kind: null, seq: null, step: null, turn: null,
      event: null, text: null, thought: null, command: null, output: null, stderr: null, exit: null,
      tokIn: null, tokOut: null, latencyMs: null, payload: {}, obj: null,
      isWrite: false, files: [], writesFiles: [], patchRows: [],
    };
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      o = parsed as Record<string, unknown>;
    } catch {
      s.role = "bad"; bad++; steps.push(s); return;
    }
    const p = (o.payload && typeof o.payload === "object" ? o.payload : {}) as Record<string, unknown>;
    s.payload = p;
    s.type = str(o.type); s.kind = str(o.kind); s.seq = num(o.seq);
    s.step = str(p.step); s.event = str(p.event) ?? s.kind ?? s.type;
    s.text = str(p.text); s.thought = str(p.thought);
    s.command = typeof p.command === "string" ? p.command : null;
    s.output = str(p.output); s.stderr = str(p.stderr); s.exit = num(p.exit_code);
    s.tokIn = num(o.tokens_in); s.tokOut = num(o.tokens_out);
    s.latencyMs = num(o.latency_ms) ?? (typeof p.latency_s === "number" ? Math.round(p.latency_s * 1000) : null);
    if (o.type === "manifest") { manifest = o; s.obj = o; s.role = "manifest"; }
    else if (o.type === "verdict") { verdict = o; s.obj = o; s.role = "verdict"; s.output = str(o.output); }
    else if (s.command != null) { s.role = "cmd"; s.isWrite = WRITE_RE.test(s.command); }
    else if (s.thought != null || s.text != null) s.role = "model";
    const m = /^model:(\d+)/.exec(s.step || "");
    if (m) s.turn = +m[1];
    if (s.role === "model" && s.turn != null) turns.set(s.turn, { turn: s.turn, model: s, cmds: [] });
    if (s.role === "cmd" && s.turn != null) turns.get(s.turn)?.cmds.push(s);
    steps.push(s);
  });
  return { steps, turns, manifest, verdict, bad };
}

export interface Field { name: string; value: string }

/** Decoded, human-readable fields of a step (used for display, search and references). */
export function fields(s: Step): Field[] {
  const out: Field[] = [];
  if (s.role === "manifest") {
    out.push({ name: "manifest", value: JSON.stringify(s.obj, null, 2) });
    return out;
  }
  if (s.text != null) out.push({ name: "text", value: s.text });
  if (s.thought != null) out.push({ name: "thought", value: s.thought });
  if (s.command != null) out.push({ name: "command", value: s.command });
  if (s.output != null && s.output !== "") out.push({ name: "output", value: s.output });
  if (s.stderr != null && s.stderr !== "") out.push({ name: "stderr", value: s.stderr });
  if (s.role === "event") {
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(s.payload)) if (!["output", "stderr", "text", "thought", "command"].includes(k)) rest[k] = s.payload[k];
    out.push({ name: "payload", value: JSON.stringify(rest, null, 1) });
  }
  if (s.role === "bad") out.push({ name: "raw", value: s.raw });
  return out;
}

/** Where a field lives inside the jsonl object (used in copied references). */
export function fieldPath(s: Step, name: string): string {
  if (name === "manifest") return "manifest (formatted JSON)";
  if (name === "payload") return "payload (formatted JSON)";
  if (name === "raw") return "raw line";
  if (s.role === "verdict" && name === "output") return "output";
  return "payload." + name;
}

/** Patch line → step that wrote it. */
export interface Origin { step: Step; inferred: boolean; candidates: number }

export interface LinkResult {
  origins: Map<PatchLine, Origin>;
  /** Steps whose command mentions each patch file. */
  fileSteps: Map<PatchFile, Step[]>;
  stats: { lines: number; linked: number; inferred: number };
}

function meaningful(t: string): boolean { return t.length >= 8 && /[A-Za-z0-9_]{3}/.test(t); }

/**
 * Links trajectory steps to patch rows: the text of each +/- line is searched in the
 * commands that write files. Short lines ("}", blank) inherit the origin of their
 * neighbours in the same +/- run. Resets and fills step.files / writesFiles / patchRows.
 */
export function link(pm: PatchModel, tr: Trajectory): LinkResult {
  const cmds = tr.steps.filter((s) => s.role === "cmd");
  const writes = cmds.filter((s) => s.isWrite);
  for (const s of tr.steps) { s.files = []; s.writesFiles = []; s.patchRows = []; }
  const origins = new Map<PatchLine, Origin>();
  const fileSteps = new Map<PatchFile, Step[]>();
  const stats = { lines: 0, linked: 0, inferred: 0 };

  for (const f of pm.files) {
    const st = f.path ? cmds.filter((s) => s.command!.includes(f.path)) : [];
    fileSteps.set(f, st);
    for (const s of st) { s.files.push(f); if (s.isWrite) s.writesFiles.push(f); }
  }

  for (const f of pm.files) for (const h of f.hunks) {
    const run: PatchLine[] = [];
    const closeRun = () => {
      for (let i = 1; i < run.length; i++) {
        const prev = origins.get(run[i - 1]);
        if (!origins.has(run[i]) && prev) origins.set(run[i], { step: prev.step, inferred: true, candidates: 0 });
      }
      for (let i = run.length - 2; i >= 0; i--) {
        const next = origins.get(run[i + 1]);
        if (!origins.has(run[i]) && next) origins.set(run[i], { step: next.step, inferred: true, candidates: 0 });
      }
      run.length = 0;
    };
    let prevKind: string | null = null;
    for (const L of h.body) {
      if (L.kind !== "add" && L.kind !== "del") { closeRun(); prevKind = null; continue; }
      if (prevKind !== L.kind) closeRun();
      prevKind = L.kind;
      const t = L.text.slice(1).trim();
      if (meaningful(t)) {
        const cands = writes.filter((s) => s.command!.includes(t));
        if (cands.length) {
          const pref = cands.filter((s) => s.command!.includes(f.path));
          origins.set(L, { step: pref[0] || cands[0], inferred: false, candidates: cands.length });
        }
      }
      run.push(L);
    }
    closeRun();
  }

  for (const L of pm.lines) {
    if (L.kind !== "add" && L.kind !== "del") continue;
    stats.lines++;
    const o = origins.get(L);
    if (o) { o.step.patchRows.push(L.row); stats.linked++; if (o.inferred) stats.inferred++; }
  }
  return { origins, fileSteps, stats };
}

/** Position of a patch line's text inside the command of its origin step, or -1. */
export function locateInCommand(L: PatchLine, step: Step): number {
  const t = L.text.slice(1).trim();
  return t && step.command ? step.command.indexOf(t) : -1;
}

export function stepLabel(s: Step): string {
  if (s.role === "cmd") return "turn " + s.turn + " · command";
  if (s.role === "model") return "turn " + s.turn + " · model";
  return s.event || s.role;
}
