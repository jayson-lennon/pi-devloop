import type { WorkflowState } from "./types.js";
import { loadPlanFile, phaseFilename } from "./state.js";

/**
 * Build the full prompt for a handoff implementation session.
 * This is what gets auto-submitted in the new session.
 */
export function buildImplementationPrompt(cwd: string, state: WorkflowState): string {
	const phase = state.phases[state.currentPhaseIndex];
	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;

	const highLevelPlan = loadPlanFile(cwd, state.workflowDir, "high-level.md") ?? "";
	const detailedPlan = loadPlanFile(cwd, state.workflowDir, phaseFilename(phase.index)) ?? "";

	return (
		`## Task\n\n` +
		`Implement Phase ${idx}/${total}: ${phase.name}\n\n` +
		`## High-Level Plan\n\n${highLevelPlan}\n\n` +
		`## Detailed Plan for Phase ${idx}: ${phase.name}\n\n${detailedPlan}\n\n` +
		`## Instructions\n\n` +
		`Implement the detailed plan above step by step.\n` +
		`After implementation, perform a self-review:\n\n` +
		`## Review: Phase ${idx} - ${phase.name}\n` +
		`### What was implemented\n<summary>\n\n` +
		`### Divergence from plan\n<changes/deviations>\n\n` +
		`### Potential problems\n<risks and concerns>\n\n` +
		`### Questions for the user\n<numbered questions>\n\n` +
		`End your review with: [IMPLEMENTATION REVIEW COMPLETE]`
	);
}
