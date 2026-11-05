// Exact, shareable references to text inside a trajectory step.

export interface TextReference {
  /** e.g. "run.trajectory.jsonl:380 › payload.command › 6:26-49" */
  short: string;
  /** "6:26-49" or "6:26-8:3" (1-based, end column inclusive). */
  loc: string;
  start: number;
  text: string;
}

/** 1-based line and column of a character offset inside a value. */
export function lineCol(value: string, offset: number): [number, number] {
  const before = value.slice(0, offset);
  return [before.split("\n").length, offset - before.lastIndexOf("\n")];
}

/**
 * Builds a reference for value[start, start + text.length).
 * Returns null when the text is not exactly at that offset.
 */
export function makeReference(fileName: string, jsonlLine: number, fieldPath: string, value: string, start: number, text: string): TextReference | null {
  if (!text || value.slice(start, start + text.length) !== text) return null;
  const end = start + text.length;
  const [l1, c1] = lineCol(value, start);
  const [l2, c2] = lineCol(value, Math.max(start, end - 1));
  const loc = l1 === l2 ? l1 + ":" + c1 + "-" + c2 : l1 + ":" + c1 + "-" + l2 + ":" + c2;
  return { short: fileName + ":" + jsonlLine + " › " + fieldPath + " › " + loc, loc, start, text };
}

/** Clipboard text: the reference, the step, the exact position and the text itself. */
export function referenceText(ref: TextReference, step: string, fieldPath: string): string {
  const fence = ref.text.includes("```") ? "~~~" : "```";
  return "Reference: " + ref.short + "\n" +
    "Step: " + step + "\n" +
    "Position: line:column inside " + fieldPath + " (offset " + ref.start + ", " + ref.text.length + " characters)\n" +
    "Text:\n" + fence + "\n" + ref.text + "\n" + fence + "\n";
}
