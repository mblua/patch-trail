// Claude Code session transcripts. Two shapes share the same message objects:
//  - the session file Claude Code keeps on disk (~/.claude/projects/<project>/<session>.jsonl):
//    {"type": "user" | "assistant" | "system" | "summary" | ..., "message": {...}, "cwd", "sessionId", ...}
//  - the output of `claude -p --output-format stream-json --verbose`:
//    {"type": "system", "subtype": "init", ...}, {"type": "assistant", "message": {...}}, ..., {"type": "result"}
// A turn is one model response (one message id; on disk its content blocks are split over several
// lines). Thinking and text blocks become model steps, tool_use blocks become commands, and
// tool_result blocks become events of the same turn. Files written with Write / Edit / MultiEdit /
// NotebookEdit are rendered as a command that holds the written text, so the linker can find it.

import { badStep, isObj, newStep, num, str, WRITE_RE, type Step, type TrajectorySchema } from "./types";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Forward slashes, and relative to the session directory when the file is inside it. */
export function relPath(p: unknown, cwd: string | null): string {
  let s = String(p ?? "").replace(/\\/g, "/");
  if (cwd) {
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (s.toLowerCase().startsWith(base.toLowerCase())) s = s.slice(base.length);
  }
  return s;
}

/** Text of a tool call as shown in the trajectory and searched by the linker. */
export function renderToolCall(name: string, input: Record<string, unknown>, cwd: string | null): string {
  const edit = (e: Record<string, unknown>) =>
    "<<<<<<< old_string\n" + String(e.old_string ?? "") + "\n=======\n" + String(e.new_string ?? "") + "\n>>>>>>> new_string" +
    (e.replace_all ? " (replace all)" : "");
  switch (name) {
    case "Bash":
    case "PowerShell": return String(input.command ?? "");
    case "Write": return "Write " + relPath(input.file_path, cwd) + "\n" + String(input.content ?? "");
    case "Edit": return "Edit " + relPath(input.file_path, cwd) + "\n" + edit(input);
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.filter(isObj) : [];
      return "MultiEdit " + relPath(input.file_path, cwd) + "\n" + edits.map(edit).join("\n");
    }
    case "NotebookEdit":
      return "NotebookEdit " + relPath(input.notebook_path, cwd) + " (" + String(input.edit_mode ?? "replace") + ")\n" + String(input.new_source ?? "");
    case "Read": return "Read " + relPath(input.file_path, cwd);
    default: return name + " " + JSON.stringify(input);
  }
}

/** Text of a tool_result content (a string, or a list of text / image blocks). */
function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (isObj(b) ? (b.type === "text" ? String(b.text ?? "") : "[" + String(b.type) + "]") : String(b))).join("\n");
  return c == null ? "" : JSON.stringify(c);
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
/** Prompts Claude Code injects itself (slash commands, hook output, reminders). */
const injected = (t: string) => /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook)/.test(t) || t.startsWith("Caveat:");

export const claudeCodeSchema: TrajectorySchema = {
  id: "claude-code",
  label: "Claude Code session",

  detect(sample) {
    let score = 0;
    for (const L of sample) {
      const o = L.obj;
      if (!o) continue;
      if ((o.type === "assistant" || o.type === "user") && isObj(o.message)) score += 3;
      else if (o.type === "system" && o.subtype === "init" && "session_id" in o) score += 10;
      else if (o.type === "summary" && "leafUuid" in o) score += 2;
      if (typeof o.sessionId === "string") score += 1;
    }
    return score;
  },

  parse(lines) {
    const steps: Step[] = [];
    const manifest: Record<string, unknown> = { scaffold: "Claude Code" };
    let cwd: string | null = null;
    let turn = 0;
    const turnOf = new Map<string, number>();
    const tools = new Map<string, Step>();
    let firstTs: number | null = null, lastTs: number | null = null;

    for (const L of lines) {
      const o = L.obj;
      if (!o) { steps.push(badStep(L)); continue; }
      if (typeof o.cwd === "string") cwd = o.cwd;
      if (typeof o.timestamp === "string") {
        const t = Date.parse(o.timestamp);
        if (!Number.isNaN(t)) { firstTs ??= t; lastTs = t; }
      }
      const sid = str(o.sessionId ?? o.session_id);
      if (sid && manifest.run_id == null) manifest.run_id = sid;
      if (typeof o.version === "string" && manifest.scaffold === "Claude Code") manifest.scaffold = "Claude Code " + o.version;
      if (typeof o.gitBranch === "string" && o.gitBranch) manifest.git_branch ??= o.gitBranch;

      const base = (): Step => {
        const s = newStep(L.line, L.raw);
        s.type = str(o.type);
        const rest: Record<string, unknown> = {};
        for (const k of Object.keys(o)) if (k !== "message" && k !== "toolUseResult") rest[k] = o[k];
        s.payload = rest;
        return s;
      };
      const msg = isObj(o.message) ? o.message : null;

      if (o.type === "assistant" && msg) {
        const id = str(msg.id) ?? str(o.uuid) ?? "line" + L.line;
        const known = turnOf.get(id);
        const t = known ?? ++turn;
        if (known == null) turnOf.set(id, t);
        if (typeof msg.model === "string" && msg.model !== "<synthetic>") manifest.model ??= msg.model;
        const usage = isObj(msg.usage) ? msg.usage : null;
        const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
        const made: Step[] = [];
        content.forEach((b, j) => {
          if (!isObj(b)) return;
          const s = base();
          s.turn = t;
          const at = "message.content[" + j + "]";
          if (b.type === "thinking" || b.type === "redacted_thinking") {
            s.role = "model"; s.step = "model:" + t;
            const thinking = b.type === "thinking" ? String(b.thinking ?? "") : "";
            // Claude Code may keep only the signature of the reasoning, not its text.
            s.thought = thinking || "(reasoning not included in the transcript)";
            s.paths = { thought: at + ".thinking" };
          } else if (b.type === "text") {
            s.role = "model"; s.step = "model:" + t;
            s.text = String(b.text ?? "");
            s.paths = { text: at + ".text" };
          } else if (b.type === "tool_use") {
            const name = String(b.name ?? "tool"), input = isObj(b.input) ? b.input : {};
            s.role = "cmd"; s.tool = name; s.step = "model:" + t + ":" + name;
            s.command = renderToolCall(name, input, cwd);
            s.isWrite = FILE_TOOLS.has(name) || (SHELL_TOOLS.has(name) && WRITE_RE.test(s.command));
            s.paths = { command: at + ".input (rendered)" };
            if (typeof b.id === "string") tools.set(b.id, s);
          } else {
            s.event = "assistant · " + String(b.type);
          }
          made.push(s);
        });
        if (!made.length) { const s = base(); s.turn = t; s.event = "assistant"; made.push(s); }
        if (usage && known == null) {
          made[0].tokIn = num(usage.input_tokens);
          made[0].tokOut = num(usage.output_tokens);
        }
        steps.push(...made);
        continue;
      }

      if (o.type === "user" && msg) {
        const content = msg.content;
        if (typeof content === "string") {
          const s = base();
          s.event = o.isMeta || injected(content) ? "user · injected" : "user prompt";
          s.text = content; s.paths = { text: "message.content" };
          if (s.event === "user prompt" && manifest.task_title == null) manifest.task_title = clip(content.trim().split("\n")[0], 100);
          steps.push(s);
          continue;
        }
        const made: Step[] = [];
        (Array.isArray(content) ? content : []).forEach((b, j) => {
          if (!isObj(b)) return;
          const s = base();
          const at = "message.content[" + j + "]";
          if (b.type === "tool_result") {
            const call = typeof b.tool_use_id === "string" ? tools.get(b.tool_use_id) : undefined;
            s.event = "tool result" + (call?.tool ? " · " + call.tool : "");
            s.turn = call?.turn ?? null;
            s.tool = call?.tool ?? null;
            s.output = resultText(b.content); s.paths = { output: at + ".content" };
            s.exit = b.is_error ? 1 : 0;
            if (call) call.exit = s.exit;
          } else if (b.type === "text") {
            const text = String(b.text ?? "");
            s.event = o.isMeta || injected(text) ? "user · injected" : "user prompt";
            s.text = text; s.paths = { text: at + ".text" };
            if (s.event === "user prompt" && manifest.task_title == null) manifest.task_title = clip(text.trim().split("\n")[0], 100);
          } else s.event = "user · " + String(b.type);
          made.push(s);
        });
        if (!made.length) { const s = base(); s.event = "user"; made.push(s); }
        steps.push(...made);
        continue;
      }

      const s = base();
      if (o.type === "system" && o.subtype === "init") {
        s.event = "system · init";
        if (typeof o.cwd === "string") cwd = o.cwd;
        if (typeof o.model === "string") manifest.model ??= o.model;
        if (typeof o.claude_code_version === "string") manifest.scaffold = "Claude Code " + o.claude_code_version;
      } else if (o.type === "result") {
        s.event = "result" + (o.subtype ? " · " + String(o.subtype) : "");
        s.output = str(o.result); s.paths = { output: "result" };
        s.exit = o.is_error ? 1 : 0;
        if (typeof o.duration_ms === "number") manifest.timings = { total_s: o.duration_ms / 1000 };
        if (typeof o.total_cost_usd === "number") manifest.cost_usd = o.total_cost_usd;
      } else if (o.type === "summary") {
        s.event = "summary"; s.text = str(o.summary); s.paths = { text: "summary" };
      } else {
        s.event = [o.type, o.subtype].filter((x) => typeof x === "string").join(" · ") || "event";
        if (typeof o.content === "string") { s.text = o.content; s.paths = { text: "content" }; }
        else if (typeof o.message === "string") { s.text = o.message; s.paths = { text: "message" }; }
        const call = typeof o.tool_use_id === "string" ? tools.get(o.tool_use_id) : undefined;
        if (call) s.turn = call.turn;
      }
      steps.push(s);
    }
    if (manifest.timings == null && firstTs != null && lastTs != null && lastTs > firstTs) manifest.timings = { total_s: (lastTs - firstTs) / 1000 };
    if (cwd) manifest.cwd = cwd;
    return { steps, manifest, verdict: null };
  },
};
