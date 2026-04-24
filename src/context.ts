import type { WorkflowState } from "./types.js";
import { loadPlanFile, phaseFilename } from "./state.js";

/**
 * Build the step-specific context injected via before_agent_start.
 * Returns null if no context should be injected.
 */
export function getStepContext(state: WorkflowState, cwd: string): string | null {
	switch (state.step) {
		case "high_level_planning":
			return getHighLevelPlanningContext(state);
		case "detailed_planning":
			return getDetailedPlanningContext(state, cwd);
		case "implementing":
			return getImplementationContext(state, cwd);
		case "integrating":
			return getIntegratingContext(state, cwd);
		case "done":
			return null;
		default:
			return null;
	}
}

// ── High-Level Planning Context ─────────────────────────────────────────

function getHighLevelPlanningContext(state: WorkflowState): string {
	return (
		`[DEVLOOP: HIGH-LEVEL PLANNING]\n` +
		`Task: ${state.task}\n\n` +
		`You are creating a high-level implementation plan.\n\n` +
		`Requirements:\n` +
		`- Explore the codebase first to understand the current state\n` +
		`- Break the work into numbered phases using this EXACT format:\n` +
		`  ### Phase 1: <short name>\n` +
		`  <description of what this phase accomplishes>\n\n` +
		`- Each phase should be independently implementable\n` +
		`- Be specific about what each phase changes\n` +
		`- After creating the plan, self-review it:\n` +
		`  - Identify gaps, risks, and ambiguities\n` +
		`  - Ask the user clarifying questions using a "### Questions for the user" section\n` +
		`- When the plan is ready for final approval, output: [HIGH-LEVEL PLAN COMPLETE]\n` +
		`- Save the plan to ${state.workflowDir}high-level.md\n\n` +
		`Do NOT implement anything — only plan.`
	);
}

// ── Detailed Planning Context ───────────────────────────────────────────

function getDetailedPlanningContext(state: WorkflowState, cwd: string): string {
	const phase = state.phases[state.currentPhaseIndex];
	if (!phase) return null;

	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;
	const highLevelPlan = loadPlanFile(cwd, state.workflowDir, "high-level.md") ?? "(not found)";

	let context =
		`[DEVLOOP: DETAILED PLANNING]\n` +
		`Phase ${idx}/${total}: ${phase.name}\n` +
		`Description: ${phase.description}\n\n` +
		`## High-Level Plan\n${highLevelPlan}\n\n` +

		`Create a detailed step-by-step implementation plan for this phase.\n\n` +
		`Requirements:\n` +
		`- List specific files to modify or create\n` +
		`- Describe exact changes needed\n` +
		`- Note dependencies and ordering\n` +
		`- Identify potential risks\n` +
		`- Save the plan to ${state.workflowDir}${phaseFilename(phase.index)}\n` +
		`- After creating the plan, self-review it and ask clarifying questions\n` +
		`- When ready for approval, output: [DETAILED PLAN COMPLETE]\n\n` +
		`Do NOT implement anything — only plan.`;

	return context;
}

// ── Implementation Context ──────────────────────────────────────────────

function getImplementationContext(state: WorkflowState, cwd: string): string {
	const phase = state.phases[state.currentPhaseIndex];
	if (!phase) return null;

	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;
	const highLevelPlan = loadPlanFile(cwd, state.workflowDir, "high-level.md") ?? "(not found)";
	const detailedPlan =
		loadPlanFile(cwd, state.workflowDir, phaseFilename(phase.index)) ?? "(not found)";

	return (
		`[DEVLOOP: IMPLEMENTING]\n` +
		`Phase ${idx}/${total}: ${phase.name}\n\n` +
		`## High-Level Plan\n${highLevelPlan}\n\n` +
		`## Detailed Plan\n${detailedPlan}\n\n` +
		`Implement the detailed plan above step by step.\n\n` +
		`Instructions:\n` +
		`- Follow the detailed plan closely\n` +
		`- Mark completed steps with [DONE:n] tags\n` +
		`- If you encounter a CRITICAL issue that blocks all progress, output: [BLOCKED: <description>]\n` +
		`- After completing implementation, perform a self-review:\n\n` +
		`## Review: Phase ${idx} - ${phase.name}\n` +
		`### What was implemented\n<summary of changes>\n\n` +
		`### Divergence from plan\n<list any changes/deviations from the detailed plan>\n\n` +
		`### Potential problems\n<risks, concerns, things that might break>\n\n` +
		`### Questions for the user\n<numbered list of questions>\n\n` +
		`- End your review with: [IMPLEMENTATION REVIEW COMPLETE]`
	);
}

// ── Integration Context ─────────────────────────────────────────────────

function getIntegratingContext(state: WorkflowState, cwd: string): string {
	const phase = state.phases[state.currentPhaseIndex];
	if (!phase) return null;

	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;
	const isLast = state.currentPhaseIndex >= total - 1;

	if (isLast) {
		return (
			`[DEVLOOP: INTEGRATING — FINAL]\n` +
			`All ${total} phases are complete.\n\n` +
			`Update the high-level plan (${state.workflowDir}high-level.md) with final divergence notes for Phase ${idx}.\n` +
			`Then output: [WORKFLOW COMPLETE]\n\n` +
			`Include a brief summary of everything accomplished.`
		);
	}

	const nextPhase = state.phases[state.currentPhaseIndex + 1];
	const nextIdx = state.currentPhaseIndex + 2;

	return (
		`[DEVLOOP: INTEGRATING]\n` +
		`Phase ${idx}/${total} (${phase.name}) just completed.\n\n` +
		`Step 1: Update the high-level plan (${state.workflowDir}high-level.md) with divergence notes:\n` +
		`- Add a "## Divergence: Phase ${idx} — ${phase.name}" section\n` +
		`- Note any deviations from the original plan\n` +
		`- Adjust remaining phase descriptions if the divergence affects them\n\n` +
		`Step 2: Create a detailed plan for Phase ${nextIdx}: ${nextPhase.name}\n` +
		`- Save to ${state.workflowDir}${phaseFilename(nextPhase.index)}\n` +
		`- Self-review and ask clarifying questions\n` +
		`- When ready for approval, output: [DETAILED PLAN COMPLETE]\n\n` +
		`Do NOT start implementing Phase ${nextIdx}.`
	);
}
