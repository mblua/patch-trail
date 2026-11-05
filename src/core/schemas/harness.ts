// Harness JSONL: one JSON object per line, {"type": "manifest" | "step" | "verdict"}.
// Agent turns are steps named "model:N"; the shell commands of turn N are "model:N:bash".

import { badStep, isObj, newStep, num, str, WRITE_RE, type Step, type TrajectorySchema } from "./types";

export const harnessSchema: TrajectorySchema = {
  id: "harness-jsonl",
  label: "Harness JSONL (manifest / step / verdict)",

  detect(sample) {
    let score = 0;
    for (const L of sample) {
      const o = L.obj;
      if (!o) continue;
      if (o.type === "manifest") score += 10;
      else if (o.type === "verdict") score += 5;
      else if (o.type === "step" && isObj(o.payload)) score += 2;
    }
    return score;
  },

  parse(lines) {
    const steps: Step[] = [];
    let manifest: Record<string, unknown> | null = null;
    let verdict: Record<string, unknown> | null = null;
    for (const L of lines) {
      const o = L.obj;
      if (!o) { steps.push(badStep(L)); continue; }
      const s = newStep(L.line, L.raw);
      const p = (isObj(o.payload) ? o.payload : {}) as Record<string, unknown>;
      s.payload = p;
      s.type = str(o.type); s.kind = str(o.kind); s.seq = num(o.seq);
      s.step = str(p.step); s.event = str(p.event) ?? s.kind ?? s.type;
      s.text = str(p.text); s.thought = str(p.thought);
      s.command = typeof p.command === "string" ? p.command : null;
      s.output = str(p.output); s.stderr = str(p.stderr); s.exit = num(p.exit_code);
      s.tokIn = num(o.tokens_in); s.tokOut = num(o.tokens_out);
      s.latencyMs = num(o.latency_ms) ?? (typeof p.latency_s === "number" ? Math.round(p.latency_s * 1000) : null);
      if (o.type === "manifest") { manifest = o; s.obj = o; s.role = "manifest"; }
      else if (o.type === "verdict") { verdict = o; s.obj = o; s.role = "verdict"; s.output = str(o.output); s.paths = { output: "output" }; }
      else if (s.command != null) { s.role = "cmd"; s.tool = "bash"; s.isWrite = WRITE_RE.test(s.command); }
      else if (s.thought != null || s.text != null) s.role = "model";
      const m = /^model:(\d+)/.exec(s.step || "");
      if (m) s.turn = +m[1];
      steps.push(s);
    }
    return { steps, manifest, verdict };
  },
};
