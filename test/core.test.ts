import { describe as suite, expect, it } from "vitest";
import { describe, parsePatch, rangeText, sideBySide } from "../src/core/patch";
import { fieldPath, fields, link, locateInCommand, parseTrajectory, stepLabel } from "../src/core/trajectory";
import { lineCol, makeReference, referenceText } from "../src/core/reference";
import { PATCH, TRAJECTORY } from "./fixtures";

const rowOf = (pm: ReturnType<typeof parsePatch>, text: string) => {
  const L = pm.lines.find((l) => l.text === text);
  if (!L) throw new Error("row not found: " + text);
  return L;
};

suite("parsePatch", () => {
  const pm = parsePatch(PATCH);

  it("finds files and hunks", () => {
    expect(pm.files.map((f) => f.path)).toEqual(["src/greeter.py", "README.md"]);
    expect(pm.files[0].hunks).toHaveLength(2);
    expect(pm.files[1].status).toBe("added");
    expect(pm.files[0].add).toBe(4);
    expect(pm.files[0].del).toBe(1);
  });

  it("hunk bodies match their headers", () => {
    for (const f of pm.files) for (const h of f.hunks) {
      expect(h.body.filter((l) => l.kind !== "add" && l.kind !== "nonl")).toHaveLength(h.oldCount);
      expect(h.body.filter((l) => l.kind !== "del" && l.kind !== "nonl")).toHaveLength(h.newCount);
    }
  });

  it("maps rows to old/new line numbers", () => {
    const del = rowOf(pm, '-    return "Hello " + name');
    expect([del.row, del.old, del.new, del.newAnchor]).toEqual([7, 2, null, 2]);
    const add = rowOf(pm, "+    if not name:");
    expect([add.row, add.old, add.new, add.oldAnchor]).toEqual([8, null, 2, 3]);
    const ctx = rowOf(pm, " def farewell(name):");
    expect([ctx.old, ctx.new]).toEqual([5, 7]);
    const shout = rowOf(pm, "     return text.upper()");
    expect([shout.old, shout.new]).toEqual([12, 14]);
    const readme = rowOf(pm, "+# Greeter");
    expect([readme.new, readme.file?.path]).toEqual([1, "README.md"]);
  });

  it("describes rows", () => {
    expect(describe(rowOf(pm, "+    if not name:")).primary).toEqual({ side: "new", line: 2 });
    expect(describe(rowOf(pm, '-    return "Hello " + name')).primary).toEqual({ side: "old", line: 2 });
    expect(describe(pm.lines[4]).hint).toBe("hunk start · old 1–5 → new 1–7");
    expect(describe(pm.lines[0]).hint).toBe("file header");
    expect(rangeText(0, 0)).toBe("∅ (after 0)");
  });

  it("pairs hunks side by side", () => {
    const pairs = sideBySide(pm.files[0].hunks[0]);
    expect(pairs[0].left?.kind).toBe("ctx");
    expect([pairs[1].left?.kind, pairs[1].right?.text]).toEqual(["del", "+    if not name:"]);
    expect([pairs[2].left, pairs[3].left]).toEqual([null, null]);
    expect(pairs).toHaveLength(7);
  });

  it("handles CRLF and patches without a diff --git header", () => {
    const p = parsePatch("--- a/x.txt\r\n+++ b/x.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(p.files).toHaveLength(1);
    expect(p.files[0].path).toBe("x.txt");
    expect(p.lines[4].new).toBe(1);
  });
});

suite("trajectory", () => {
  const pm = parsePatch(PATCH);
  const tr = parseTrajectory(TRAJECTORY);

  it("parses roles, turns and unreadable lines", () => {
    expect(tr.steps.map((s) => s.role)).toEqual(["manifest", "model", "cmd", "model", "cmd", "model", "cmd", "event", "bad", "verdict"]);
    expect(tr.turns.size).toBe(3);
    expect(tr.turns.get(2)?.cmds.map((s) => s.seq)).toEqual([4]);
    expect(tr.bad).toBe(1);
    expect(tr.manifest?.run_id).toBe("run-0001");
    expect(tr.steps.filter((s) => s.isWrite).map((s) => s.seq)).toEqual([4, 6]);
  });

  it("links every meaningful +/- line to the step that wrote it", () => {
    const res = link(pm, tr);
    const writer = tr.steps.find((s) => s.seq === 4)!;
    const readme = tr.steps.find((s) => s.seq === 6)!;
    for (const t of ['-    return "Hello " + name', "+    if not name:", '+        raise ValueError("name must not be empty")', '+    return f"Hello, {name}!"']) {
      expect(res.origins.get(rowOf(pm, t))?.step).toBe(writer);
    }
    expect(res.origins.get(rowOf(pm, "+# Greeter"))?.step).toBe(readme);
    expect(res.origins.get(rowOf(pm, "+A tiny greeting library used in tests."))?.step).toBe(readme);
    // a lone blank "+" line has no text and no neighbours: unlinked
    expect(res.origins.get(pm.lines.find((l) => l.text === "+")!)).toBeUndefined();
    expect(res.stats).toEqual({ lines: 7, linked: 6, inferred: 0 });
    expect(writer.patchRows).toEqual([7, 8, 9, 10]);
    expect(res.fileSteps.get(pm.files[0])?.map((s) => s.seq)).toEqual([2, 4]);
    expect(writer.writesFiles.map((f) => f.path)).toEqual(["src/greeter.py"]);
  });

  it("short lines inherit the origin of their run", () => {
    const p = parsePatch(["--- a/a.py", "+++ b/a.py", "@@ -1,1 +1,4 @@", " x = 1", "+def helper_function():", "+    pass", "+"].join("\n"));
    const t = parseTrajectory(JSON.stringify({ type: "step", payload: { step: "model:1:bash", command: "cat > a.py <<'EOF'\nx = 1\ndef helper_function():\n    pass\nEOF" } }));
    const res = link(p, t);
    expect(res.stats).toEqual({ lines: 3, linked: 3, inferred: 2 });
  });

  it("locates a line inside its origin command", () => {
    link(pm, tr);
    const L = rowOf(pm, "+    if not name:");
    const writer = tr.steps.find((s) => s.seq === 4)!;
    const i = locateInCommand(L, writer);
    expect(writer.command!.slice(i, i + 12)).toBe("if not name:");
  });

  it("exposes fields and their JSON paths", () => {
    const model = tr.steps[1];
    expect(fields(model).map((f) => f.name)).toEqual(["text", "thought"]);
    expect(fieldPath(model, "thought")).toBe("payload.thought");
    expect(fieldPath(tr.steps[9], "output")).toBe("output");
    expect(stepLabel(tr.steps[4])).toBe("turn 2 · command");
  });
});

suite("references", () => {
  const value = "first line\nsecond line here\n";

  it("computes 1-based line:column", () => {
    expect(lineCol(value, 0)).toEqual([1, 1]);
    expect(lineCol(value, 11)).toEqual([2, 1]);
  });

  it("builds an exact reference", () => {
    const start = value.indexOf("line here");
    const ref = makeReference("run.jsonl", 12, "payload.output", value, start, "line here")!;
    expect(ref.short).toBe("run.jsonl:12 › payload.output › 2:8-16");
    expect(makeReference("run.jsonl", 12, "payload.output", value, start + 1, "line here")).toBeNull();
    const multi = makeReference("run.jsonl", 3, "payload.text", value, 6, "line\nsecond")!;
    expect(multi.loc).toBe("1:7-2:6");
  });

  it("formats the clipboard text with the text in a fence", () => {
    const ref = makeReference("run.jsonl", 1, "payload.text", "a ```b``` c", 0, "a ```b```")!;
    const out = referenceText(ref, "turn 1 · model", "payload.text");
    expect(out).toContain("Reference: run.jsonl:1 › payload.text › 1:1-9");
    expect(out).toContain("~~~\na ```b```\n~~~");
  });
});
