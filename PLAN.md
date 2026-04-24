# DevLoop — Phased Workflow Extension for Pi

An implementation plan for a pi extension that structures multi-phase development
work into a plan → review → implement → review → integrate loop.

---

## Architecture Overview

**No coordinator session.** Each session implements AND plans the next phase.
The `.plans/` directory on disk is the source of truth. State is file-based so
any pi instance can pick up where things left off.

```
Session A: /workflow plan "refactor auth"
  → Agent creates high-level plan → self-reviews → user iterates → approved
  → /workflow start
  → Agent creates detailed plan for Phase 1 → self-reviews → user iterates → approved
  → Handoff to new session with plans injected

Session B: (auto-seeded with plans)
  → Agent implements Phase 1
  → Agent self-reviews (structured report + questions)
  → User responds conversationally
  → Decision gate: approve
  → Agent updates high-level plan with divergence
  → Agent generates detailed plan for Phase 2 → self-reviews
  → Decision gate: approve (+ escape hatch)
  → Handoff to new session

Session C: (auto-seeded with plans)
  → ... repeat until all phases complete
```

### File Structure (in user's project)

```
.plans/
  refactor-auth/
    high-level.md            # Living document — updated after each phase
    phase-1-detailed.md      # Created before implementation, never deleted
    phase-2-detailed.md
    workflow.json             # Machine state: current phase, step, status
```

### Extension Source Structure

```
/mnt/zed/repos/devloop/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts           # Entry point — registers everything
    types.ts           # Type definitions
    state.ts           # Workflow state read/write (.plans/ file I/O)
    commands.ts        # /workflow plan, start, status, abort, continue
    context.ts         # before_agent_start context injection per step
    markers.ts         # Marker detection in turn_end / agent_end
    gates.ts           # Decision gates via ctx.ui.select
    handoff.ts         # ctx.newSession() with plan injection
    git.ts             # Auto-commit after phase review
    notifications.ts   # Non-blocking session_start notification
```

---

## Lifecycle Trace

### Flow A: High-Level Planning

```
1. User: /workflow plan "refactor auth system"

2. Extension:
   - Create .plans/refactor-auth/ directory
   - Write workflow.json: { status: "planning", currentPhaseIndex: -1, phases: [] }
   - Inject "create high-level plan" context via before_agent_start
   - Tell agent to output the plan in a specific format with phase headers

3. Agent:
   - Explores codebase (YOLO — all tools available)
   - Creates high-level plan with numbered phases
   - Outputs structured plan with ### Phase N: <name> headers
   - Ends with marker: [HIGH-LEVEL PLAN COMPLETE]

4. Extension (turn_end):
   - Detects marker
   - Extracts plan text
   - Tells agent to self-review the plan and ask clarifying questions

5. Agent:
   - Self-reviews: identifies gaps, risks, ambiguities
   - Asks user questions in "Questions for the user" format

6. User:
   - Responds conversationally with answers/feedback

7. Agent:
   - Revises plan based on feedback
   - Outputs revised plan with [HIGH-LEVEL PLAN COMPLETE] marker

8. Extension (agent_end or marker detected):
   - Decision gate (ctx.ui.select):
     ✅ Approve — save plan, ready for Flow B
     ✏️ Revise — open editor for feedback, agent revises (back to step 7)
     ❌ Abort — delete .plans/ directory

9. On approve:
   - Save plan to .plans/refactor-auth/high-level.md
   - Parse phase names/descriptions into workflow.json
   - Set status to "ready"
```

### Flow B: The Loop

```
1. User: /workflow start
   (or /workflow continue if resuming)

2. Extension:
   - Read workflow.json, determine current phase (phase 1)
   - Set step to "detailed_planning"
   - Inject "create detailed plan for Phase N" context

3. Agent:
   - Creates detailed step-by-step plan for Phase 1
   - Writes it to .plans/refactor-auth/phase-1-detailed.md
   - Self-reviews: identifies risks, ambiguities
   - Asks user questions
   - Ends with [DETAILED PLAN COMPLETE]

4. Extension (marker detected):
   - Decision gate:
     ✅ Approve — proceed to implementation
     ✏️ Revise — provide feedback, agent revises
     🔄 Start this phase over (re-plan from scratch)
     ❌ Abort workflow

5. On approve:
   - Extension calls ctx.newSession() with setup:
     - Inject user message containing:
       - High-level plan (full text from high-level.md)
       - Detailed plan for Phase 1 (full text from phase-1-detailed.md)
       - "Implement this plan. After implementation, perform a self-review."
     - Update workflow.json: step = "implementing"
     - Auto-submit (no editor review)

6. New session (Session B):
   - Extension detects workflow is active on session_start
   - Reads workflow.json, sees step = "implementing"
   - before_agent_start injects implementation context
   - Agent implements the plan

7. Agent (after implementation):
   - Performs self-review using structured format:

     ## Review: Phase 1 - <name>

     ### What was implemented
     <summary>

     ### Divergence from plan
     <changes/deviations from detailed plan>

     ### Potential problems
     <risks, concerns, things that might break>

     ### Questions for the user
     <numbered list of questions>

   - Ends with [IMPLEMENTATION REVIEW COMPLETE]

8. Extension (marker detected):
   - Decision gate:
     ✅ Looks good — integrate and continue
     ✏️ Minor issues — describe them (editor), then continue
     🔄 Restart this phase — start over with new detailed plan
     ❌ Abort workflow

9. On approve:
   - Extension tells agent to:
     a. Update high-level plan with divergence notes
     b. If last phase → [WORKFLOW COMPLETE]
     c. If not last → generate detailed plan for next phase

10. Agent:
    - Updates .plans/refactor-auth/high-level.md with divergence section
    - If more phases:
      - Creates .plans/refactor-auth/phase-N-detailed.md
      - Self-reviews, asks questions
      - [DETAILED PLAN COMPLETE]
    - If last phase:
      - [WORKFLOW COMPLETE]

11. Decision gate (after integration):
    ✅ Continue to next phase → handoff (back to step 5)
    ✏️ Edit high-level plan first → escape hatch (see below)
    ❌ Abort workflow

12. Escape hatch:
    - ctx.ui.select: "Adjust remaining phases?"
      - No, continue
      - Yes, let me edit → ctx.ui.editor with current high-level.md content
      - Yes, have agent propose revisions → agent revises, then approve
    - After editing, continue to next phase

13. After approval + before handoff:
    - Auto git commit: "phase N/M: <phase name>"
```

---

## Implementation Phases

### Phase 1: Project Scaffolding

**Files:** `package.json`, `tsconfig.json`, `src/types.ts`

Initialize the git repo and create the extension package.

**package.json:**
- Name: `devloop`
- Keywords: `["pi-package"]`
- `pi.extensions: ["./src/index.ts"]`
- Peer deps: `@mariozechner/pi-coding-agent`, `@sinclair/typebox`, etc.

**src/types.ts — Core types:**

```typescript
type WorkflowStatus =
  | "planning"        // Flow A: creating high-level plan
  | "ready"           // Flow A complete, awaiting /workflow start
  | "active"          // Flow B: in the loop
  | "complete"        // All phases done
  | "aborted";

type WorkflowStep =
  | "high_level_planning"
  | "detailed_planning"
  | "pending_approval"     // waiting at a decision gate
  | "implementing"
  | "implementation_review"
  | "integrating"
  | "done";

interface PhaseInfo {
  index: number;
  name: string;
  description: string;
  status: "pending" | "in_progress" | "complete";
  detailedPlanFile?: string;     // e.g., "phase-1-detailed.md"
  divergenceNotes?: string;
}

interface WorkflowState {
  task: string;
  workflowDir: string;          // relative path: .plans/<slug>/
  status: WorkflowStatus;
  step: WorkflowStep;
  currentPhaseIndex: number;
  phases: PhaseInfo[];
  createdAt: number;
  updatedAt: number;
}
```

**Deliverables:**
- [ ] Git repo initialized
- [ ] package.json with pi manifest
- [ ] tsconfig.json
- [ ] src/types.ts with all type definitions

---

### Phase 2: State Management

**Files:** `src/state.ts`

All state lives on disk in `.plans/<slug>/`. No in-memory state that can't be
reconstructed from files.

**Responsibilities:**
- `createWorkflow(cwd, taskName)` — create `.plans/<slug>/` + `workflow.json` + empty `high-level.md`
- `loadWorkflow(cwd)` — find and load the active workflow (scan `.plans/` for `workflow.json` with status != "complete"/"aborted")
- `saveWorkflow(cwd, state)` — write `workflow.json`
- `saveHighLevelPlan(cwd, state, content)` — write `high-level.md`
- `loadHighLevelPlan(cwd, state)` — read `high-level.md`
- `saveDetailedPlan(cwd, state, phaseIndex, content)` — write `phase-N-detailed.md`
- `loadDetailedPlan(cwd, state, phaseIndex)` — read `phase-N-detailed.md`
- `parsePhasesFromPlan(markdown)` — extract `### Phase N: <name>` headers into PhaseInfo[]
- `slugify(taskName)` — "Refactor Auth System" → "refactor-auth-system"
- `findActiveWorkflow(cwd)` — returns WorkflowState | null

**Edge cases:**
- Multiple `.plans/` dirs with active workflows → return first, warn
- Corrupted workflow.json → surface error to user
- Missing plan files → surface error

**Deliverables:**
- [ ] src/state.ts with all file I/O functions
- [ ] Unit-testable pure functions for plan parsing

---

### Phase 3: Flow A — High-Level Planning

**Files:** `src/commands.ts` (partial), `src/context.ts` (partial), `src/markers.ts` (partial)

#### Command: `/workflow plan <task>`

```typescript
// In commands.ts
pi.registerCommand("workflow", {
  description: "Manage phased workflow: plan, start, status, abort, continue",
  handler: async (args, ctx) => {
    const [subcommand, ...rest] = args.trim().split(/\s+/);
    const taskName = rest.join(" ");

    if (subcommand === "plan") {
      // Check no active workflow already
      const existing = findActiveWorkflow(ctx.cwd);
      if (existing) { notify error; return; }

      // Create workflow state
      const state = createWorkflow(ctx.cwd, taskName);

      // Send initial prompt to agent
      pi.sendUserMessage(
        `Create a high-level plan for: ${taskName}\n\n` +
        `Explore the codebase first, then create a plan with numbered phases.\n` +
        `Use ### Phase N: <name> headers for each phase.\n` +
        `After creating the plan, self-review it and ask me clarifying questions.\n` +
        `End with [HIGH-LEVEL PLAN COMPLETE] when done.`
      );
    }
    // ... other subcommands
  }
});
```

#### Context injection

When `state.step === "high_level_planning"`, `before_agent_start` injects:

```
[WORKFLOW: HIGH-LEVEL PLANNING]
Task: <task name>
Output your plan with ### Phase N: <name> headers.
After creating the plan, self-review and ask clarifying questions.
End with [HIGH-LEVEL PLAN COMPLETE] when the plan is ready for approval.
```

#### Marker detection

`turn_end` handler watches for `[HIGH-LEVEL PLAN COMPLETE]`. When detected:
1. Extract plan text (everything before the marker)
2. Parse phases from headers
3. Decision gate:

```typescript
const choice = await ctx.ui.select("High-level plan review:", [
  "✅ Approve — save and prepare for implementation",
  "✏️ Revise — I have feedback",
  "❌ Abort workflow",
]);
```

On approve:
- Save high-level plan to `high-level.md`
- Update `workflow.json` with parsed phases, `status: "ready"`
- Notify user: "Plan approved. Use `/workflow start` to begin."

On revise:
- `ctx.ui.editor("Plan feedback:", "")` → inject feedback as user message
- Agent revises → marker detected again → gate again

**Deliverables:**
- [ ] `/workflow plan` command handler
- [ ] `before_agent_start` context for high-level planning
- [ ] `[HIGH-LEVEL PLAN COMPLETE]` marker detection
- [ ] Decision gate for plan approval
- [ ] Plan file saved to disk on approval

---

### Phase 4: Flow B — Detailed Planning Step

**Files:** `src/commands.ts` (continued), `src/context.ts` (continued), `src/markers.ts` (continued)

#### Command: `/workflow start`

```typescript
if (subcommand === "start") {
  const state = loadWorkflow(ctx.cwd);
  if (!state || state.status !== "ready") { error; return; }

  state.status = "active";
  state.step = "detailed_planning";
  state.currentPhaseIndex = 0;
  state.phases[0].status = "in_progress";
  saveWorkflow(ctx.cwd, state);

  const phase = state.phases[0];
  pi.sendUserMessage(
    `Create a detailed implementation plan for Phase 1: ${phase.name}\n` +
    `Description: ${phase.description}\n\n` +
    `Save it to ${state.workflowDir}phase-1-detailed.md\n` +
    `After creating the plan, self-review and ask questions.\n` +
    `End with [DETAILED PLAN COMPLETE].`
  );
}
```

#### Context injection for detailed planning

```
[WORKFLOW: DETAILED PLANNING]
Phase N/M: <name>
Description: <description>

High-level plan context:
<full text of high-level.md>

Divergence notes from previous phases:
<if any>

Create a detailed step-by-step implementation plan.
Save to .plans/<slug>/phase-N-detailed.md
Self-review and ask clarifying questions.
End with [DETAILED PLAN COMPLETE].
```

#### Marker detection

`[DETAILED PLAN COMPLETE]` → decision gate:

```typescript
const choice = await ctx.ui.select(`Detailed plan for Phase ${phaseIndex + 1}:`, [
  "✅ Approve — proceed to implementation",
  "✏️ Revise — I have feedback",
  "🔄 Re-plan this phase from scratch",
  "❌ Abort workflow",
]);
```

**Deliverables:**
- [ ] `/workflow start` command handler
- [ ] `before_agent_start` context for detailed planning
- [ ] `[DETAILED PLAN COMPLETE]` marker detection
- [ ] Decision gate for detailed plan approval
- [ ] Detailed plan file saved to disk

---

### Phase 5: Handoff

**Files:** `src/handoff.ts`

When the detailed plan is approved, create a new session seeded with the plans.

```typescript
async function handoffForImplementation(ctx, state) {
  const phaseIndex = state.currentPhaseIndex;
  const phase = state.phases[phaseIndex];
  const highLevelPlan = loadHighLevelPlan(ctx.cwd, state);
  const detailedPlan = loadDetailedPlan(ctx.cwd, state, phaseIndex);

  const implementationPrompt = `## Task\n\nImplement Phase ${phaseIndex + 1}/${state.phases.length}: ${phase.name}\n\n` +
    `## High-Level Plan\n\n${highLevelPlan}\n\n` +
    `## Detailed Plan\n\n${detailedPlan}\n\n` +
    `## Instructions\n\n` +
    `Implement the detailed plan above step by step.\n` +
    `After implementation, perform a self-review using this format:\n\n` +
    `## Review: Phase ${phaseIndex + 1} - ${phase.name}\n` +
    `### What was implemented\n<summary>\n` +
    `### Divergence from plan\n<changes/deviations>\n` +
    `### Potential problems\n<risks and concerns>\n` +
    `### Questions for the user\n<numbered questions>\n\n` +
    `End your review with [IMPLEMENTATION REVIEW COMPLETE].`;

  // Update state before handoff
  state.step = "implementing";
  saveWorkflow(ctx.cwd, state);

  const result = await ctx.newSession({
    parentSession: ctx.sessionManager.getSessionFile(),
    setup: async (sm) => {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: implementationPrompt }],
        timestamp: Date.now(),
      });
    },
  });

  // After newSession, we're in the new session context
  // The implementation prompt is already submitted
}
```

**Key decisions:**
- We use `ctx.newSession()` directly — NOT the user's existing `/handoff` command.
  Reason: we need to skip the LLM summarization and editor review. We already
  have structured content (the plans) to inject. This is the same mechanism
  the handoff extension uses internally but with our custom prompt generation.
- The prompt auto-submits — no editor for the user to review.
- `parentSession` is set for session tree traceability.

**Deliverables:**
- [ ] `handoffForImplementation()` function
- [ ] Proper prompt construction with both plans
- [ ] State updated to "implementing" before handoff
- [ ] New session seeded correctly

---

### Phase 6: Implementation & Review

**Files:** `src/context.ts` (continued), `src/markers.ts` (continued)

#### Context injection for implementation

When `state.step === "implementing"`:

```
[WORKFLOW: IMPLEMENTING]
You are implementing Phase N/M: <name>.
Follow the detailed plan. Mark completed steps with [DONE:n].
If you encounter a CRITICAL issue that blocks all progress, output [BLOCKED: <description>].
After completing implementation, perform a self-review:

## Review: Phase N - <name>
### What was implemented
### Divergence from plan
### Potential problems
### Questions for the user

End with [IMPLEMENTATION REVIEW COMPLETE].
```

#### Marker detection

1. `[BLOCKED: ...]` — during any turn, auto-detect:
   - Change state to "blocked"
   - Notify user: "🚫 Implementation blocked. See agent's message."
   - Present decision gate:
     ```
     🔄 Restart this phase (re-plan from scratch)
     ✏️ Provide guidance and retry
     ⏭️ Skip this phase
     ❌ Abort workflow
     ```

2. `[IMPLEMENTATION REVIEW COMPLETE]` — agent finished review:
   - Decision gate:
     ```
     ✅ Looks good — integrate and continue
     ✏️ Minor issues — describe and continue
     🔄 Restart this phase
     ❌ Abort workflow
     ```
   - On "Minor issues": `ctx.ui.editor("Describe issues:", "")` → feedback injected
   - On "Looks good": advance to integrating step

**Deliverables:**
- [ ] `before_agent_start` context for implementation
- [ ] `[BLOCKED: ...]` marker detection + decision gate
- [ ] `[IMPLEMENTATION REVIEW COMPLETE]` marker detection + decision gate
- [ ] State transitions on each outcome

---

### Phase 7: Integration & Next Phase

**Files:** `src/context.ts` (continued), `src/markers.ts` (continued), `src/gates.ts`

After implementation is approved, the extension tells the agent to:

1. Update high-level plan with divergence
2. Generate detailed plan for next phase (or mark complete)

#### Context injection for integration

```
[WORKFLOW: INTEGRATING]
Phase N/M just completed. Review results:

Divergence from detailed plan:
<extracted from review>

Update .plans/<slug>/high-level.md with a "## Divergence Notes" section
for this phase. Adjust remaining phase descriptions if needed.

Then create a detailed plan for Phase N+1: <name>
Save to .plans/<slug>/phase-N+1-detailed.md
Self-review and ask questions.
End with [DETAILED PLAN COMPLETE].
```

If last phase:
```
[WORKFLOW: INTEGRATING — FINAL]
All phases complete. Update high-level plan with final divergence notes.
End with [WORKFLOW COMPLETE].
```

#### Decision gates

After `[DETAILED PLAN COMPLETE]` for next phase:

```typescript
const choices = [
  "✅ Approve — continue to implementation",
  "✏️ Revise detailed plan",
];

// Escape hatch: add option to edit high-level plan
const hasRemainingPhases = state.currentPhaseIndex < state.phases.length - 1;
if (hasRemainingPhases) {
  choices.push("📝 Edit high-level plan before continuing");
}

choices.push("🔄 Restart this phase", "❌ Abort workflow");
```

On "Edit high-level plan":
```typescript
const currentPlan = loadHighLevelPlan(ctx.cwd, state);
const edited = await ctx.ui.editor("Edit high-level plan:", currentPlan);
if (edited) {
  saveHighLevelPlan(ctx.cwd, state, edited);
  // Optionally re-parse phases
  const newPhases = parsePhasesFromPlan(edited);
  // Merge: keep completed phases, update remaining
}
```

#### After approval + before handoff:
- Git auto-commit (see Phase 8)
- Then handoff (Phase 5)

**Deliverables:**
- [ ] `before_agent_start` context for integration
- [ ] Agent instructed to update high-level plan + generate next detailed plan
- [ ] `[DETAILED PLAN COMPLETE]` for next phase triggers gate with escape hatch
- [ ] `[WORKFLOW COMPLETE]` detection
- [ ] Escape hatch: edit high-level plan gate
- [ ] Phase state transitions (mark complete, advance index)

---

### Phase 8: Git Integration

**Files:** `src/git.ts`

Auto-commit after each phase is reviewed and approved, before the next detailed
plan is generated.

```typescript
async function commitPhase(ctx: ExtensionContext, state: WorkflowState): Promise<void> {
  const phaseIndex = state.currentPhaseIndex;
  const phase = state.phases[phaseIndex];
  const total = state.phases.length;
  const message = `phase ${phaseIndex + 1}/${total}: ${phase.name}`;

  await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
  await pi.exec("git", ["commit", "-m", message, "--allow-empty"], { cwd: ctx.cwd });
}
```

**Timing:** Called between "implementation review approved" and "start integration/next planning."

**Edge cases:**
- Not a git repo → skip silently, notify user
- Dirty working tree before commit → commit anyway (user approved the implementation)
- Commit fails → surface error, don't block workflow

**Deliverables:**
- [ ] `commitPhase()` function
- [ ] Git repo detection
- [ ] Error handling for non-git projects

---

### Phase 9: Session Notifications

**Files:** `src/notifications.ts`

On `session_start`, check for active workflow and show a non-blocking notification.

```typescript
pi.on("session_start", async (_event, ctx) => {
  const state = findActiveWorkflow(ctx.cwd);
  if (!state || state.status === "complete" || state.status === "aborted") return;

  const phase = state.phases[state.currentPhaseIndex];
  const completed = state.phases.filter(p => p.status === "complete").length;
  const total = state.phases.length;

  ctx.ui.notify(
    `Active workflow: "${state.task}" — ` +
    `Phase ${state.currentPhaseIndex + 1}/${total} (${state.step})\n` +
    `Use /workflow status for details.`,
    "info",
  );
});
```

This is fire-and-forget — no dismissal needed, doesn't block the session.

**Deliverables:**
- [ ] `session_start` handler
- [ ] Non-blocking notification for active workflows
- [ ] No notification when no active workflow

---

### Phase 10: Additional Commands & Edge Cases

**Files:** `src/commands.ts` (completed)

#### `/workflow status`

Show current workflow state, phase progress, step.

#### `/workflow abort`

Mark workflow as aborted. Optionally: delete `.plans/` directory? Or just mark and leave files?

Decision: mark as aborted in workflow.json, leave files. User can clean up manually.

#### `/workflow continue`

Resume a workflow that's in "ready" or "active" state. Picks up from the current step by injecting the appropriate context.

#### `/workflow restart-phase`

Restart the current phase: clear detailed plan, go back to "detailed_planning" step.

#### Edge cases to handle:
- **Session crashes mid-step:** On next `session_start`, the extension reads workflow state from disk and can resume. The `/workflow continue` command explicitly picks up where things left off.
- **User edits workflow.json manually:** Validate on load, surface errors.
- **Plan files deleted externally:** Detect on load, surface error with recovery options.
- **Concurrent sessions:** The workflow state is on disk, so concurrent sessions could conflict. Mitigate by: reading state fresh before each operation, and notifying if state changed unexpectedly.
- **Empty project (no files yet):** Plan command should still work — agent creates from scratch.

**Deliverables:**
- [ ] `/workflow status` command
- [ ] `/workflow abort` command
- [ ] `/workflow continue` command
- [ ] `/workflow restart-phase` command
- [ ] Edge case handling for crashed/invalid state

---

## Open Questions (for implementation)

1. **Should the extension auto-detect when the agent saves plan files?** The agent uses the `write` tool to save `.plans/.../phase-N-detailed.md`. The extension could detect this via `tool_call` event and auto-validate the file contents. Or we trust the agent to do it correctly. Recommendation: trust the agent, validate on load.

2. **How many tokens do the injected prompts consume?** For large high-level plans, the `before_agent_start` injection could be substantial. We should consider truncation or summarization for very large plans. For now: inject the full plan text.

3. **Should workflow.json track which session "owns" the workflow?** This would help prevent concurrent sessions from conflicting. But it adds complexity. For v1: don't track, just use non-blocking notifications.

4. **Should the extension provide a `/workflow list` to see all workflows (including completed/aborted)?** Nice-to-have for v2.

---

## Marker Protocol

The extension and agent communicate step completion via markers in assistant output:

| Marker | Meaning | Extension Action |
|--------|---------|-----------------|
| `[HIGH-LEVEL PLAN COMPLETE]` | High-level plan ready for review | Decision gate: approve/revise/abort |
| `[DETAILED PLAN COMPLETE]` | Detailed plan ready for review | Decision gate: approve/revise/restart/abort |
| `[IMPLEMENTATION REVIEW COMPLETE]` | Self-review done | Decision gate: approve/issues/restart/abort |
| `[BLOCKED: <reason>]` | Critical issue | Decision gate: restart/guidance/skip/abort |
| `[WORKFLOW COMPLETE]` | All phases done | Final summary, notification |
| `[DONE:n]` | Step n within a phase completed | Progress tracking (optional widget) |

Markers are detected in `turn_end` by scanning assistant message text.

---

## Context Injection Protocol

`before_agent_start` injects a hidden message based on current workflow step:

| Step | Injected Context |
|------|-----------------|
| `high_level_planning` | Task description, format instructions, self-review instructions |
| `detailed_planning` | High-level plan, phase info, divergence notes, format instructions |
| `implementing` | High-level plan, detailed plan, implementation instructions, review format |
| `integrating` | Divergence from review, instructions to update high-level plan, next phase info |

The injected message has `display: false` — user doesn't see it, but it's in the LLM context.

---

## Implementation Order

Build in this order to have something testable at each step:

1. **Phase 1** — Scaffolding (can verify with `pi -e ./src/index.ts`)
2. **Phase 2** — State management (can verify file I/O with a test script)
3. **Phase 10** (partial) — `/workflow status` (useful for debugging)
4. **Phase 3** — Flow A: high-level planning (end-to-end testable)
5. **Phase 4** — Flow B: detailed planning (testable with Flow A output)
6. **Phase 5** — Handoff (testable with detailed plan output)
7. **Phase 6** — Implementation + review markers (testable end-to-end)
8. **Phase 7** — Integration + next phase (testable full loop)
9. **Phase 8** — Git commits
10. **Phase 9** — Session notifications
11. **Phase 10** (complete) — All commands + edge cases
