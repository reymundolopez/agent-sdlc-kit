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
# Coder Role Contract
Follow the `SessionStart` brief and `.bv/packets/ISSUE-<n>/code.md`.
Use only `bv <verb>` commands (`bv read-slice`, `bv search`, `bv outline`, `bv gate-green`, `bv check-scope`, `bv lint-types`).
Never edit locked test files.
