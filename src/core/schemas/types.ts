// Shared trajectory model. Every schema (one per coding agent or harness format) turns its
// .jsonl into this model; the linker and the UI only see these types.

import type { PatchFile } from "../patch";

export type StepRole = "manifest" | "verdict" | "model" | "cmd" | "event" | "bad";

export interface Step {
  /** Position in Trajectory.steps (a .jsonl line can produce several steps). */
  index: number;
  /** 1-based line in the .jsonl file. */
  line: number;
  raw: string;
  role: StepRole;
  type: string | null;
  kind: string | null;
  seq: number | null;
  step: string | null;
  /** Agent turn N (one model response and the tool calls it made). */
  turn: number | null;
  event: string | null;
  /** Tool that ran a "cmd" step ("bash", "Write", "Edit", ...). */
  tool: string | null;
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
  /** Where each field lives inside the JSON line, when it is not "payload.<field>". */
  paths: Record<string, string> | null;
  isWrite: boolean;
  /** Patch files whose path appears in this step's command. */
  files: PatchFile[];
  /** Patch files this step wrote. */
  writesFiles: PatchFile[];
  /** Patch rows whose origin is this step. */
  patchRows: number[];
}

export interface Turn {
  turn: number;
  /** First model step of the turn, if any. */
  model: Step | null;
  /** Text and reasoning of all the model steps of the turn, joined. */
  text: string | null;
  thought: string | null;
  cmds: Step[];
}

export interface SchemaInfo { id: string; label: string }

export interface Trajectory {
  schema: SchemaInfo;
  steps: Step[];
  turns: Map<number, Turn>;
  /** Run metadata: task_title, model, scaffold, run_id, timings (real or built by the schema). */
  manifest: Record<string, unknown> | null;
  verdict: Record<string, unknown> | null;
  bad: number;
}

/** A parsed .jsonl line: the object, or null when the line is not a JSON object. */
export interface JsonLine { line: number; raw: string; obj: Record<string, unknown> | null }

export interface TrajectorySchema {
  id: string;
  label: string;
  /** Score how well the first lines of a file match this schema (0 = not at all). */
  detect(sample: JsonLine[]): number;
  parse(lines: JsonLine[]): Omit<Trajectory, "schema" | "turns" | "bad">;
}

/** Shell commands that write files: python open(path, "w"), sed -i, cat > file, tee, git apply, ... */
export const WRITE_RE =
  /sed\s+-i|open\([^)]*?["']w["']|\.write_text\(|perl\s+-p?i|git\s+apply|patch\s+-p\d|cat\s*>|cat\s+<<[^\n]*>|\btee\b|>\s*[\w./-]+\.(rs|json|toml|md|py|js|ts|tsx|jsx|go|java|c|h|cpp|yaml|yml|txt)\b/;

export const str = (v: unknown): string | null => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
export const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function newStep(line: number, raw: string): Step {
  return {
    index: -1, line, raw, role: "event", type: null, kind: null, seq: null, step: null, turn: null,
    event: null, tool: null, text: null, thought: null, command: null, output: null, stderr: null, exit: null,
    tokIn: null, tokOut: null, latencyMs: null, payload: {}, obj: null, paths: null,
    isWrite: false, files: [], writesFiles: [], patchRows: [],
  };
}

export function badStep(L: JsonLine): Step {
  const s = newStep(L.line, L.raw);
  s.role = "bad";
  return s;
}
