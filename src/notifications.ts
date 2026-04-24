import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "./types.js";

/**
 * Show a non-blocking notification if an active workflow exists.
 * Fire-and-forget — no dismissal needed.
 */
export function checkAndNotify(ctx: ExtensionContext, state: WorkflowState): void {
	const phase = state.phases[state.currentPhaseIndex];
	const total = state.phases.length;
	const completed = state.phases.filter((p) => p.status === "complete").length;

	const phaseInfo = phase
		? `Phase ${state.currentPhaseIndex + 1}/${total}: ${phase.name}`
		: `(${total} phases planned)`;

	ctx.ui.notify(
		`Active workflow: "${state.task}" — ${phaseInfo} [${state.step}]\n` +
			`Use /workflow status for details.`,
		"info",
	);
}
