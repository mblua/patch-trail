// Registry of trajectory schemas. A schema reads one coding agent's (or harness's) .jsonl format
// into the shared model of ./types. To support a new agent, add a schema here.

import { claudeCodeSchema } from "./claudeCode";
import { harnessSchema } from "./harness";
import type { JsonLine, Step, Trajectory, TrajectorySchema, Turn } from "./types";

export const SCHEMAS: readonly TrajectorySchema[] = [harnessSchema, claudeCodeSchema];

const SAMPLE = 200;

export function splitLines(text: string): JsonLine[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((raw, i) => {
    let obj: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
    } catch { /* unreadable line */ }
    return { line: i + 1, raw, obj };
  });
}

/** The schema that best matches the file; the harness schema when nothing matches. */
export function detectSchema(lines: JsonLine[]): TrajectorySchema {
  const sample = lines.slice(0, SAMPLE);
  let best = SCHEMAS[0], score = 0;
  for (const s of SCHEMAS) {
    const n = s.detect(sample);
    if (n > score) { best = s; score = n; }
  }
  return best;
}

export function buildTurns(steps: Step[]): Map<number, Turn> {
  const turns = new Map<number, Turn>();
  const get = (n: number) => {
    let t = turns.get(n);
    if (!t) { t = { turn: n, model: null, text: null, thought: null, cmds: [] }; turns.set(n, t); }
    return t;
  };
  const join = (a: string | null, b: string | null) => (b == null || b === "" ? a : a ? a + "\n\n" + b : b);
  for (const s of steps) {
    if (s.turn == null) continue;
    if (s.role === "model") {
      const t = get(s.turn);
      t.model ??= s;
      t.text = join(t.text, s.text);
      t.thought = join(t.thought, s.thought);
    } else if (s.role === "cmd") get(s.turn).cmds.push(s);
  }
  return turns;
}

/** Parses a trajectory with the given schema id, or the detected one. */
export function parseWithSchema(text: string, schemaId?: string): Trajectory {
  const lines = splitLines(text);
  const schema = SCHEMAS.find((s) => s.id === schemaId) ?? detectSchema(lines);
  const { steps, manifest, verdict } = schema.parse(lines);
  steps.forEach((s, i) => { s.index = i; });
  return {
    schema: { id: schema.id, label: schema.label },
    steps, turns: buildTurns(steps), manifest, verdict,
    bad: steps.filter((s) => s.role === "bad").length,
  };
}
