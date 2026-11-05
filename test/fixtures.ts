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
