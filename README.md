# Patch Trail

A VS Code extension for reviewing a `.patch` produced by a coding agent together with the
agent's trajectory (`.jsonl`).

- **Real line numbers**: next to every row of the patch, its line in the file: `a 29` for a
  removed line (original file, `a/`), `b 29` for an added line (new file, `b/`), the plain
  number for context lines. The strip under the patch hides or shows each gutter column
  (`#` patch row, `a/b` file line, `T` turn) and shows the cursor position.
- **Agent blame**: every `+`/`−` line carries a chip with the agent turn that wrote it
  (same color = same turn); while you scroll through a long run of lines from one turn, its chip
  stays pinned at the top. The *Why this line exists* panel shows the agent's message,
  its reasoning and the exact command, with the line highlighted.
- **Trajectory table**: every step of the trajectory, filterable (model, commands, steps that
  wrote the patch, steps with search matches), with the full step below.
- **Cross find**: `Ctrl+F` / `Cmd+F` searches the patch and the trajectory at the same time.
- **Exact references**: select text in a step and press **Copy reference** to copy
  `file.jsonl:line › payload.field › line:col` together with the text, ready to paste.
  In the patch, **Copy reference** (next to **Details**) copies the cursor row, or the text
  selected in it, as `run.patch:1209:36-62 → path/to/file.rs:29:35-61`, with its turn and text.
- **Show / hide panes** with the three layout buttons in the editor title bar (top right):
  the patch, the trajectory and the line details panel (position, *Why this line exists*,
  hunk side by side). The panel also closes with its `✕`, the **Details** button in the
  patch header or the `D` key.

## Usage

1. Click the **Patch Trail** icon in the activity bar. The sidebar lists the `.patch` / `.diff`
   files of the workspace (with their trajectory, if any) and the **Current Patch**: its
   trajectory, checkboxes to show or hide the patch, the trajectory and the line details panel,
   and actions.
   Click a patch to open it. You can also open a `.patch` file and click **Open in Patch Trail**
   in the editor title bar, or right-click it in the Explorer → **Open in Patch Trail**.
2. The trajectory is found automatically when it sits next to the patch as
   `<patch>.trajectory.jsonl` (for example `run.patch` → `run.patch.trajectory.jsonl`).
3. Otherwise use **Open trajectory…** in the trajectory pane, **Change…**, the trajectory item
   in the status bar, or the command **Patch Trail: Associate Trajectory…**. The choice is
   remembered per workspace.

To always open patches in Patch Trail, add this to your settings:

```json
"workbench.editorAssociations": { "*.patch": "patchTrail.patchView" }
```

### Keys (patch pane)

| Key | Action |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` | Move the cursor |
| `N` / `P` | Next / previous hunk |
| `D` | Show / hide the line details panel |
| `Ctrl+F`, `F3`, `Shift+F3` | Find in both panes, next / previous match |

### Commands

| Command | Description |
| --- | --- |
| Patch Trail: Open in Patch Trail | Open the selected `.patch` / `.diff` |
| Patch Trail: Associate Trajectory… | Pick the `.jsonl` for the current patch |
| Patch Trail: Reset Trajectory Association | Forget the choice and look for the default again |
| Patch Trail: Find in Patch and Trajectory | Cross find |
| Patch Trail: Show/Hide Patch, Show/Hide Trajectory | Same as the editor title bar buttons |
| Patch Trail: Show/Hide Line Details | Close or reopen the line details panel |
| Patch Trail: Reopen as Text | Back to the plain text editor |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `patchTrail.trajectorySuffix` | `.trajectory.jsonl` | Suffix that turns a patch path into its default trajectory path |
| `patchTrail.followCursor` | `true` | Select the step that wrote the line under the cursor |

## Trajectory format

One JSON object per line. Patch Trail understands the shape used by
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)-style harnesses:

- `{"type": "manifest", ...}`: run metadata (`task_title`, `model`, `scaffold`, `run_id`, `timings`).
- `{"type": "step", "seq": n, "payload": {"step": "model:N", "text": "...", "thought": "..."}}`: an agent turn.
- `{"type": "step", "payload": {"step": "model:N:bash", "command": "...", "output": "...", "exit_code": 0}}`: a command of turn N.
- `{"type": "verdict", "pass": true, "output": "..."}`: the grading result.

Other lines are shown as events. A patch line is attributed to the first command that writes
files (`open(path, "w")`, `sed -i`, `cat >`, `tee`, `git apply`, …) and contains its text.
Short lines such as `}` inherit the turn of their neighbours and are shown dimmed.

## Development

```sh
npm install
npm run check              # type check, unit tests, build
npm run test:integration   # runs the extension inside a downloaded VS Code
npm run package            # builds patch-trail-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

To work on the UI in a browser:

```sh
npm run build
node scripts/harness.mjs path/to/run.patch [path/to/trajectory.jsonl]
# open .harness/index.html
```

`.harness/` embeds the files you pass and is git-ignored. Never commit real patches or
trajectories: tests use the synthetic fixtures in `test/fixtures.ts`.

## License

[MIT](LICENSE)
