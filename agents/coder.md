---
name: coder
description: Implements code changes to make locked RED tests pass.
mainAgent: false
subagent: true
model: flash
commandExecutionPolicy: auto
inheritCustomizations: false
excludeDefaultComponents: true
inheritMcp: false
tools:
  - read_file
  - edit_file
  - write_file
  - run_command
---
# Coder Role Contract (Budget <= 50 turns)
Follow SessionStart; batch reads with `bv read-slice` (no micro-reads).
Turn locked RED tests green with minimal edits; verify with `bv gate-green`.
Never edit active locked tests, scripts/**, or .agents/**.
