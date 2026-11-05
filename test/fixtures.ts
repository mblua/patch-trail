// Synthetic fixtures (a made-up "greeter" project). Never put real patches or trajectories here.

export const PATCH = [
  "diff --git a/src/greeter.py b/src/greeter.py",
  "index 1111111..2222222 100644",
  "--- a/src/greeter.py",
  "+++ b/src/greeter.py",
  "@@ -1,5 +1,7 @@",
  " def greet(name):",
  '-    return "Hello " + name',
  "+    if not name:",
  '+        raise ValueError("name must not be empty")',
  '+    return f"Hello, {name}!"',
  " ",
  " ",
  " def farewell(name):",
  "@@ -10,3 +12,4 @@ def farewell(name):",
  " ",
  " def shout(text):",
  "     return text.upper()",
  "+",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1,2 @@",
  "+# Greeter",
  "+A tiny greeting library used in tests.",
  "",
].join("\n");

const WRITE_GREETER = [
  "python3 -c '",
  'path = "src/greeter.py"',
  "content = open(path).read()",
  "content = content.replace('    return \"Hello \" + name', '''    if not name:",
  '        raise ValueError("name must not be empty")',
  "    return f\"Hello, {name}!\"''')",
  'open(path, "w").write(content)',
  "'",
].join("\n");

const WRITE_README = ["cat > README.md <<'EOF'", "# Greeter", "A tiny greeting library used in tests.", "EOF"].join("\n");

const rows: unknown[] = [
  { type: "manifest", run_id: "run-0001", task_title: "greeter-validation", model: "example/model", scaffold: "example-agent@1.0", timings: { total_s: 120 } },
  { type: "step", seq: 1, kind: "step", latency_ms: 1200, tokens_in: 100, tokens_out: 20, payload: { step: "model:1", text: "Let me read the greeter module.", thought: "I should inspect src/greeter.py first." } },
  { type: "step", seq: 2, kind: "step", latency_ms: 50, payload: { step: "model:1:bash", command: "cat src/greeter.py", exit_code: 0, output: 'def greet(name):\n    return "Hello " + name\n' } },
  { type: "step", seq: 3, kind: "step", latency_ms: 900, payload: { step: "model:2", text: "I will validate the name and change the greeting." } },
  { type: "step", seq: 4, kind: "step", latency_ms: 80, payload: { step: "model:2:bash", command: WRITE_GREETER, exit_code: 0, output: "" } },
  { type: "step", seq: 5, kind: "step", latency_ms: 700, payload: { step: "model:3", text: "Now a README." } },
  { type: "step", seq: 6, kind: "step", latency_ms: 40, payload: { step: "model:3:bash", command: WRITE_README, exit_code: 0, output: "" } },
  { type: "step", seq: 7, kind: "provision", payload: { event: "teardown", elapsed_s: 1.5 } },
];

export const TRAJECTORY = rows.map((r) => JSON.stringify(r)).join("\n") + "\nthis line is not json\n" +
  JSON.stringify({ type: "verdict", pass: true, output: "[PASS] greet-validates-name" }) + "\n";

export { WRITE_GREETER, WRITE_README };

// The same change made by Claude Code, as its on-disk session file: each content block of a
// response is its own line (same message id), tool results come back as "user" lines.
const CWD = "C:\\work\\greeter";
const meta = { cwd: CWD, sessionId: "sess-0001", version: "2.0.0", gitBranch: "main" };
const say = (id: string, block: unknown, usage?: unknown) => ({
  ...meta, type: "assistant", timestamp: "2026-01-01T10:00:0" + id.slice(-1) + "Z",
  message: { id, role: "assistant", model: "claude-example", content: [block], ...(usage ? { usage } : {}) },
});
const result = (id: string, content: string, isError = false) =>
  ({ ...meta, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

const claudeRows: unknown[] = [
  { type: "summary", summary: "Greeter validation", leafUuid: "u-9" },
  { ...meta, type: "user", message: { role: "user", content: "Validate the name in greet() and add a README." }, timestamp: "2026-01-01T10:00:00Z" },
  say("msg_1", { type: "thinking", thinking: "I should inspect src/greeter.py first." }, { input_tokens: 100, output_tokens: 20 }),
  say("msg_1", { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: CWD + "\\src\\greeter.py" } }, { input_tokens: 100, output_tokens: 20 }),
  result("tu_1", '1\tdef greet(name):\n2\t    return "Hello " + name\n'),
  say("msg_2", { type: "text", text: "I will validate the name and change the greeting." }),
  say("msg_2", {
    type: "tool_use", id: "tu_2", name: "Edit", input: {
      file_path: CWD + "\\src\\greeter.py",
      old_string: '    return "Hello " + name',
      new_string: '    if not name:\n        raise ValueError("name must not be empty")\n    return f"Hello, {name}!"',
    },
  }),
  result("tu_2", "The file was updated."),
  say("msg_3", { type: "text", text: "Now a README." }),
  say("msg_3", { type: "tool_use", id: "tu_3", name: "Write", input: { file_path: CWD + "\\README.md", content: "# Greeter\nA tiny greeting library used in tests.\n" } }),
  result("tu_3", "File created."),
  say("msg_4", { type: "text", text: "Done." }),
];

export const CLAUDE_TRAJECTORY = claudeRows.map((r) => JSON.stringify(r)).join("\n") + "\n";

// The output of "claude -p --output-format stream-json --verbose" for a similar session.
export const CLAUDE_STREAM = [
  { type: "system", subtype: "init", session_id: "sess-0002", cwd: "/work/greeter", model: "claude-example", claude_code_version: "2.0.0", tools: ["Bash", "Edit", "Write"] },
  {
    type: "assistant", session_id: "sess-0002",
    message: {
      id: "msg_a", role: "assistant", model: "claude-example", content: [
        { type: "text", text: "Adding a README." },
        { type: "tool_use", id: "tu_a", name: "Bash", input: { command: "cat > README.md <<'EOF'\n# Greeter\nA tiny greeting library used in tests.\nEOF" } },
      ],
    },
  },
  { type: "user", session_id: "sess-0002", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: [{ type: "text", text: "" }] }] } },
  { type: "result", subtype: "success", is_error: false, duration_ms: 4000, result: "Done.", total_cost_usd: 0.01, session_id: "sess-0002" },
].map((r) => JSON.stringify(r)).join("\n") + "\n";
