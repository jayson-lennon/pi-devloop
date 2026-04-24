# DevLoop — Phased Workflow Extension for Pi

A [pi](https://github.com/badlogic/pi) extension that structures multi-phase development work into a **plan → review → implement → integrate** loop.

## How It Works

### Two Flows

**Flow A** — One-time setup:
```
/workflow plan "refactor auth system"
  → Agent explores codebase and creates high-level plan
  → Agent self-reviews and asks clarifying questions
  → You iterate conversationally
  → Decision gate: approve → plan saved to .plans/
```

**Flow B** — The implementation loop (repeats per phase):
```
/workflow start
  → Agent creates detailed plan for Phase 1
  → Decision gate: approve
  → Handoff to new session (fresh context window)
  → Agent implements Phase 1
  → Agent self-reviews (structured report + questions)
  → You respond conversationally
  → Decision gate: approve
  → Agent updates high-level plan with divergence notes
  → Agent generates detailed plan for Phase 2
  → Decision gate: approve (with escape hatch to edit high-level plan)
  → Git auto-commit
  → Handoff to new session
  → ... repeat until all phases complete
```

### Key Principles

- **No coordinator session** — each session implements AND plans the next phase
- **State on disk** — `.plans/<slug>/` holds all plans and workflow state
- **Interactive gates** — `ctx.ui.select()` at decision points, conversational for reviews
- **Fresh context per implementation** — handoff creates a new session with injected plans
- **Blocking issue support** — agent can signal `[BLOCKED:]` for critical problems

## Installation

```bash
pi install /mnt/zed/repos/devloop
```

Or for development:
```bash
pi -e /mnt/zed/repos/devloop/src/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/workflow plan <task>` | Create a high-level plan for a task |
| `/workflow start` | Begin the implementation loop |
| `/workflow status` | Show current workflow state and progress |
| `/workflow continue` | Resume after interruption |
| `/workflow restart-phase` | Restart the current phase from scratch |
| `/workflow abort` | Abort the workflow (files preserved) |

## File Structure

```
.plans/
  my-feature/
    workflow.json           # Machine state
    high-level.md           # Living plan document (updated with divergence notes)
    phase-1-detailed.md     # Detailed plan for phase 1
    phase-2-detailed.md     # Detailed plan for phase 2
```

## Marker Protocol

The extension and agent communicate via markers in assistant output:

| Marker | Meaning |
|--------|---------|
| `[HIGH-LEVEL PLAN COMPLETE]` | Plan ready for approval |
| `[DETAILED PLAN COMPLETE]` | Detailed plan ready for approval |
| `[IMPLEMENTATION REVIEW COMPLETE]` | Self-review done |
| `[BLOCKED: <reason>]` | Critical blocking issue |
| `[WORKFLOW COMPLETE]` | All phases done |
| `[DONE:n]` | Step n completed (progress tracking) |

## Decision Gates

After each major step, a selection dialog appears:

**After high-level plan:** Approve / Revise / Abort

**After detailed plan:** Approve / Revise / Re-plan / Abort

**After implementation:** Approve / Minor issues / Restart / Abort

**After next-phase plan (with escape hatch):** Approve / Revise / Re-plan / Edit high-level plan / Abort

## Implementation Review Format

The agent produces a structured self-review:

```markdown
## Review: Phase 1 - Auth Middleware

### What was implemented
<summary of changes>

### Divergence from plan
<changes/deviations from the detailed plan>

### Potential problems
<risks, concerns, things that might break>

### Questions for the user
1. The token refresh approach diverged — is this acceptable?
2. Should we update the high-level plan?
```

## Git Integration

Auto-commits after each phase is reviewed, before the next detailed plan:
- Format: `phase N/M: <phase name>`
- Skipped silently if not a git repo

## License

MIT
