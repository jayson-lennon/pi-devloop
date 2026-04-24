/**
 * DevLoop — Phased Workflow Extension for Pi
 *
 * Structures multi-phase development into a plan → review → implement → integrate loop.
 * State lives on disk in .plans/<slug>/. No coordinator session needed.
 *
 * Commands:
 *   /workflow plan <task>       — Create high-level plan
 *   /workflow start             — Begin implementation loop
 *   /workflow status            — Show current workflow state
 *   /workflow abort             — Abort the workflow
 *   /workflow continue          — Resume after interruption
 *   /workflow restart-phase     — Restart current phase from scratch
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState, DetectedMarker } from "./types.js";
import {
	findActiveWorkflow,
	saveWorkflow,
	savePlanFile,
	loadPlanFile,
	parsePhasesFromPlan,
	phaseFilename,
	loadAndDeleteHandoffPrompt,
} from "./state.js";
import { detectMarkers, getPrimaryMarker, extractTextFromMessage } from "./markers.js";
import { getStepContext } from "./context.js";
import {
	gatePlanReview,
	gateDetailedPlanReview,
	gateImplementationReview,
	gateBlocked,
	gateNextPhase,
} from "./gates.js";
import { commitPhase } from "./git.js";
import { checkAndNotify } from "./notifications.js";
import { registerCommands } from "./commands.js";

export default function devloop(pi: ExtensionAPI): void {
	// Track the most recently detected marker for agent_end processing
	let pendingMarker: DetectedMarker | null = null;

	// ── Register Commands ───────────────────────────────────────────

	registerCommands(pi);

	// ── session_start ───────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		const state = findActiveWorkflow(ctx.cwd);
		if (!state) return;

		// Check for pending handoff prompt (auto-submit)
		const prompt = loadAndDeleteHandoffPrompt(ctx.cwd, state.workflowDir);
		if (prompt && (event.reason === "new" || event.reason === "fork")) {
			pi.sendUserMessage(prompt);
			return;
		}

		// Show non-blocking notification
		checkAndNotify(ctx, state);
	});

	// ── before_agent_start ──────────────────────────────────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = findActiveWorkflow(ctx.cwd);
		if (!state) return;

		// Only inject context when the workflow is actively running
		if (state.status === "planning" || state.status === "active") {
			const context = getStepContext(state, ctx.cwd);
			if (context) {
				return {
					message: {
						customType: "devloop-context",
						content: context,
						display: false,
					},
				};
			}
		}
	});

	// ── turn_end ────────────────────────────────────────────────────

	pi.on("turn_end", async (event, _ctx) => {
		const state = findActiveWorkflow(_ctx.cwd);
		if (!state) return;

		// Only watch for markers when workflow is active
		if (state.status !== "planning" && state.status !== "active") return;

		// Extract text from assistant message
		if (event.message?.role !== "assistant") return;
		const text = extractTextFromMessage(event.message);
		if (!text) return;

		// Detect markers
		const markers = detectMarkers(text);
		const primary = getPrimaryMarker(markers);

		if (primary) {
			pendingMarker = primary;
		}
	});

	// ── agent_end ───────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const state = findActiveWorkflow(ctx.cwd);
		if (!state) return;

		if (!pendingMarker) return;
		const marker = pendingMarker;
		pendingMarker = null;

		// Route based on marker type and current workflow step
		switch (marker.type) {
			case "high_level_plan":
				await handleHighLevelPlanComplete(pi, ctx, state);
				break;

			case "detailed_plan":
				await handleDetailedPlanComplete(pi, ctx, state);
				break;

			case "implementation_review":
				await handleImplementationReviewComplete(pi, ctx, state);
				break;

			case "blocked":
				await handleBlocked(pi, ctx, state, marker.data ?? "Unknown reason");
				break;

			case "workflow_complete":
				await handleWorkflowComplete(pi, ctx, state);
				break;
		}
	});

	// ── Handler: High-Level Plan Complete ───────────────────────────

	async function handleHighLevelPlanComplete(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: WorkflowState,
	): Promise<void> {
		const result = await gatePlanReview(ctx);

		switch (result.action) {
			case "approve": {
				// Load and parse the plan
				const plan = loadPlanFile(ctx.cwd, state.workflowDir, "high-level.md");
				if (!plan) {
					ctx.ui.notify("Could not read high-level plan file.", "error");
					return;
				}

				const phases = parsePhasesFromPlan(plan);
				if (phases.length === 0) {
					ctx.ui.notify(
						"No phases detected in plan. Ensure you used ### Phase N: <name> headers.",
						"error",
					);
					// Let user revise
					state.step = "high_level_planning";
					saveWorkflow(ctx.cwd, state);
					pi.sendUserMessage(
						"No phases were detected in the plan. Please use ### Phase N: <name> headers and try again.",
					);
					return;
				}

				state.phases = phases;
				state.status = "ready";
				state.step = "done"; // Waiting for /workflow start
				saveWorkflow(ctx.cwd, state);

				ctx.ui.notify(
					`Plan approved with ${phases.length} phases. Use /workflow start to begin.`,
					"success",
				);
				break;
			}

			case "revise": {
				if (result.feedback) {
					pi.sendUserMessage(
						`Revise the high-level plan based on this feedback:\n\n${result.feedback}\n\n` +
							`When ready for approval, output: [HIGH-LEVEL PLAN COMPLETE]`,
					);
				}
				break;
			}

			case "abort": {
				state.status = "aborted";
				saveWorkflow(ctx.cwd, state);
				ctx.ui.notify("Workflow aborted.", "info");
				break;
			}
		}
	}

	// ── Handler: Detailed Plan Complete ─────────────────────────────

	async function handleDetailedPlanComplete(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: WorkflowState,
	): Promise<void> {
		const phase = state.phases[state.currentPhaseIndex];
		if (!phase) return;

		// Different gate depending on whether we're starting fresh or coming from integration
		if (state.step === "integrating") {
			// This is a detailed plan for the NEXT phase after integration
			await handleNextPhasePlanComplete(pi, ctx, state);
		} else {
			// First detailed plan or restart
			const result = await gateDetailedPlanReview(
				ctx,
				phase,
				state.currentPhaseIndex,
				state.phases.length,
			);

			switch (result.action) {
				case "approve": {
					// Handoff to new session for implementation
					pi.sendUserMessage("/workflow _handoff");
					break;
				}

				case "revise": {
					if (result.feedback) {
						pi.sendUserMessage(
							`Revise the detailed plan for Phase ${state.currentPhaseIndex + 1}: ${phase.name}\n\n` +
								`Feedback:\n${result.feedback}\n\n` +
								`When ready for approval, output: [DETAILED PLAN COMPLETE]`,
						);
					}
					break;
				}

				case "restart": {
					pi.sendUserMessage("/workflow restart-phase");
					break;
				}

				case "abort": {
					state.status = "aborted";
					saveWorkflow(ctx.cwd, state);
					ctx.ui.notify("Workflow aborted.", "info");
					break;
				}
			}
		}
	}

	// ── Handler: Next Phase Plan Complete (post-integration) ────────

	async function handleNextPhasePlanComplete(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: WorkflowState,
	): Promise<void> {
		// NOTE: state.currentPhaseIndex points to the phase that was just implemented.
		// The detailed plan that was just created is for the NEXT phase (currentPhaseIndex + 1).
		const nextPhaseIdx = state.currentPhaseIndex + 1;
		const nextPhase = state.phases[nextPhaseIdx];
		if (!nextPhase) return;

		const result = await gateNextPhase(ctx, state, nextPhase);

		switch (result.action) {
			case "approve": {
				// Git commit for the phase that was just implemented
				const commitMsg = await commitPhase(pi, ctx.cwd, state);
				ctx.ui.notify(commitMsg, "info");

				// Advance to the next phase (the one we just planned)
				state.phases[state.currentPhaseIndex].status = "complete";
				state.currentPhaseIndex = nextPhaseIdx;
				state.step = "implementing";
				nextPhase.status = "in_progress";
				saveWorkflow(ctx.cwd, state);

				// Handoff to new session for implementation
				pi.sendUserMessage("/workflow _handoff");
				break;
			}

			case "revise": {
				if (result.feedback) {
					pi.sendUserMessage(
						`Revise the detailed plan for Phase ${nextPhaseIdx + 1}: ${nextPhase.name}\n\n` +
							`Feedback:\n${result.feedback}\n\n` +
							`When ready for approval, output: [DETAILED PLAN COMPLETE]`,
					);
				}
				break;
			}

			case "restart": {
				// Restart the NEXT phase's planning (not the current one)
				state.phases[state.currentPhaseIndex].status = "complete";
				state.currentPhaseIndex = nextPhaseIdx;
				state.step = "detailed_planning";
				nextPhase.status = "in_progress";
				saveWorkflow(ctx.cwd, state);
				pi.sendUserMessage("/workflow restart-phase");
				break;
			}

			case "edit_plan": {
				// Escape hatch: let user edit the high-level plan
				const currentPlan = loadPlanFile(ctx.cwd, state.workflowDir, "high-level.md") ?? "";
				const edited = await ctx.ui.editor("Edit high-level plan:", currentPlan);
				if (edited) {
					savePlanFile(ctx.cwd, state.workflowDir, "high-level.md", edited);

					// Re-parse phases (keep completed ones, update remaining)
					const newPhases = parsePhasesFromPlan(edited);
					if (newPhases.length > 0) {
						// Keep completed phases up to and including current
						const completedPhases = state.phases.slice(0, nextPhaseIdx);
						// Take remaining phases from re-parsed plan
						const remainingPhases = newPhases.slice(nextPhaseIdx);
						state.phases = [...completedPhases, ...remainingPhases];
						// Re-index
						state.phases.forEach((p, i) => (p.index = i));
						saveWorkflow(ctx.cwd, state);
						ctx.ui.notify("High-level plan updated.", "success");
					}

					// Re-show the gate for the (possibly updated) next phase
					await handleNextPhasePlanComplete(pi, ctx, state);
				}
				break;
			}

			case "abort": {
				state.status = "aborted";
				saveWorkflow(ctx.cwd, state);
				ctx.ui.notify("Workflow aborted.", "info");
				break;
			}
		}
	}

	// ── Handler: Implementation Review Complete ─────────────────────

	async function handleImplementationReviewComplete(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: WorkflowState,
	): Promise<void> {
		const phase = state.phases[state.currentPhaseIndex];
		if (!phase) return;

		const result = await gateImplementationReview(
			ctx,
			phase,
			state.currentPhaseIndex,
			state.phases.length,
		);

		switch (result.action) {
			case "approve": {
				// Advance to integration step
				state.step = "integrating";
				saveWorkflow(ctx.cwd, state);

				pi.sendMessage(
					{
						customType: "devloop-instruction",
						content:
							`Implementation approved. Now integrate:\n\n` +
							`1. Update the high-level plan (${state.workflowDir}high-level.md) with divergence notes for Phase ${state.currentPhaseIndex + 1}\n` +
							`2. ${
								state.currentPhaseIndex < state.phases.length - 1
									? `Create a detailed plan for Phase ${state.currentPhaseIndex + 2}: ${state.phases[state.currentPhaseIndex + 1].name}\n` +
									  `   Save to ${state.workflowDir}${phaseFilename(state.currentPhaseIndex + 1)}\n` +
									  `   When ready, output: [DETAILED PLAN COMPLETE]`
									: `This is the last phase. Output: [WORKFLOW COMPLETE]`
							}`,
						display: true,
					},
					{ triggerTurn: true },
				);
				break;
			}

			case "revise": {
				// Minor issues — note them and continue to integration
				const feedbackMsg = result.feedback
					? `\n\nIssues noted:\n${result.feedback}`
					: "";

				state.step = "integrating";
				saveWorkflow(ctx.cwd, state);

				pi.sendMessage(
					{
						customType: "devloop-instruction",
						content:
							`Implementation approved with minor issues.${feedbackMsg}\n\n` +
							`Now integrate:\n` +
							`1. Update the high-level plan with divergence notes\n` +
							`2. ${
								state.currentPhaseIndex < state.phases.length - 1
									? `Create detailed plan for next phase. Output: [DETAILED PLAN COMPLETE]`
									: `Output: [WORKFLOW COMPLETE]`
							}`,
						display: true,
					},
					{ triggerTurn: true },
				);
				break;
			}

			case "restart": {
				pi.sendUserMessage("/workflow restart-phase");
				break;
			}

			case "abort": {
				state.status = "aborted";
				saveWorkflow(ctx.cwd, state);
				ctx.ui.notify("Workflow aborted.", "info");
				break;
			}
		}
	}

	// ── Handler: Blocked ────────────────────────────────────────────

	async function handleBlocked(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: WorkflowState,
		reason: string,
	): Promise<void> {
		const phase = state.phases[state.currentPhaseIndex];
		if (!phase) return;

		const result = await gateBlocked(ctx, reason, phase);

		switch (result.action) {
			case "revise": {
				// Provide guidance and retry
				if (result.feedback) {
					pi.sendUserMessage(
						`Address this blocking issue:\n\n${result.feedback}\n\n` +
							`After addressing it, continue implementation and perform a self-review.\n` +
							`Output: [IMPLEMENTATION REVIEW COMPLETE]`,
					);
				}
				break;
			}

			case "restart": {
				pi.sendUserMessage("/workflow restart-phase");
				break;
			}

			case "skip": {
				// Mark phase as complete (skipped) and move on
				state.phases[state.currentPhaseIndex].status = "complete";
				state.currentPhaseIndex++;

				if (state.currentPhaseIndex >= state.phases.length) {
					state.step = "done";
					state.status = "complete";
					saveWorkflow(ctx.cwd, state);
					ctx.ui.notify("Workflow complete (last phase skipped).", "info");
				} else {
					state.step = "integrating";
					saveWorkflow(ctx.cwd, state);
					pi.sendMessage(
						{
							customType: "devloop-instruction",
							content:
								`Phase was skipped due to blocking issue. Moving to next phase.\n` +
								`Update the high-level plan noting the skip, then create a detailed plan for Phase ${state.currentPhaseIndex + 1}.\n` +
								`Output: [DETAILED PLAN COMPLETE]`,
							display: true,
						},
						{ triggerTurn: true },
					);
				}
				break;
			}

			case "abort": {
				state.status = "aborted";
				saveWorkflow(ctx.cwd, state);
				ctx.ui.notify("Workflow aborted.", "info");
				break;
			}
		}
	}

	// ── Handler: Workflow Complete ──────────────────────────────────

	async function handleWorkflowComplete(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: WorkflowState,
	): Promise<void> {
		// Mark all remaining phases as complete
		for (const phase of state.phases) {
			phase.status = "complete";
		}
		state.currentPhaseIndex = state.phases.length - 1;
		state.step = "done";
		state.status = "complete";
		saveWorkflow(ctx.cwd, state);

		// Final git commit
		const commitMsg = await commitPhase(pi, ctx.cwd, state);
		ctx.ui.notify(commitMsg, "info");

		ctx.ui.notify(
			`🎉 Workflow complete: "${state.task}"\n` +
				`${state.phases.length} phases finished.\n` +
				`Plan files in ${state.workflowDir}`,
			"success",
		);
	}
}
