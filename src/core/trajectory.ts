// Coding-agent trajectory (.jsonl) parser and linker: finds, for every +/- line
// of a patch, the trajectory step whose command wrote it. Each agent format is a schema
// (src/core/schemas); this module only sees the shared model.

import type { PatchFile, PatchLine, PatchModel } from "./patch";
import { parseWithSchema } from "./schemas";
import type { Step, Trajectory } from "./schemas/types";

export type { JsonLine, SchemaInfo, Step, StepRole, Trajectory, TrajectorySchema, Turn } from "./schemas/types";
export { WRITE_RE } from "./schemas/types";
export { SCHEMAS, detectSchema } from "./schemas";

/** Parses a trajectory .jsonl with the schema whose id is given, or the one that best matches it. */
export function parseTrajectory(text: string, schemaId?: string): Trajectory {
  return parseWithSchema(text, schemaId);
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
  return s.paths?.[name] ?? "payload." + name;
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
  if (s.role === "cmd") return "turn " + s.turn + " · " + (s.tool && s.tool !== "bash" ? s.tool : "command");
  if (s.role === "model") return "turn " + s.turn + " · model";
  return s.event || s.role;
}
