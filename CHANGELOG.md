# Changelog

## 0.1.0

- Patch Trail custom editor for `.patch` and `.diff` files.
- Real old/new line numbers, position card and side-by-side hunk.
- Agent blame per `+`/`−` line and *Why this line exists* panel.
- Trajectory table with filters and step detail.
- Default trajectory lookup (`<patch>.trajectory.jsonl`), open dialog, per-workspace association.
- Cross find in the patch and the trajectory.
- Copy an exact reference to selected text in a step.
- Buttons in the editor title bar to show or hide the patch, the trajectory and the line details.
- File line number column in the patch (`a 29` / `b 29`), with buttons to hide the patch row,
  file line and turn columns, and the cursor position next to them.
- **Copy reference** for the cursor row of the patch (or the text selected in it).
- The turn chip stays pinned at the top while rows of its turn are still on screen.
- Patch Trail activity bar icon: sidebar with the workspace patches and the current patch
  (trajectory, pane checkboxes, change / reset trajectory, find).
- The line details panel can be closed and reopened (`✕`, **Details** button, `D` key,
  sidebar checkbox, *Show/Hide Line Details* command); the choice is kept per editor.
