import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "./types.js";
import {
	createWorkflow,
	findActiveWorkflow,
	loadWorkflowByDir,
	saveWorkflow,
	savePlanFile,
	loadPlanFile,
	parsePhasesFromPlan,
	phaseFilename,
	saveHandoffPrompt,
} from "./state.js";
import { buildImplementationPrompt } from "./handoff.js";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("workflow", {
		description: "Phased workflow: plan, start, status, abort, continue, restart-phase",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0];
			const rest = parts.slice(1).join(" ");

			switch (subcommand) {
				case "plan":
					return handlePlan(pi, ctx, rest);
				case "start":
					return handleStart(pi, ctx);
				case "status":
					return handleStatus(ctx);
				case "abort":
					return handleAbort(ctx);
				case "continue":
					return handleContinue(pi, ctx);
				case "restart-phase":
					return handleRestartPhase(pi, ctx);
				case "_handoff":
					return handleHandoff(pi, ctx);
				default:
					ctx.ui.notify(
						"Usage: /workflow plan <task> | start | status | abort | continue | restart-phase",
						"info",
					);
			}
		},
	});
}

// ── /workflow plan <task> ───────────────────────────────────────────────

async function handlePlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	task: string,
): Promise<void> {
	if (!task) {
		ctx.ui.notify("Usage: /workflow plan <task description>", "error");
		return;
	}

	// Check for existing active workflow
	const existing = findActiveWorkflow(ctx.cwd);
	if (existing) {
		ctx.ui.notify(
			`Active workflow already exists: "${existing.task}". Use /workflow abort first.`,
			"error",
		);
		return;
	}

	const state = createWorkflow(ctx.cwd, task);
	ctx.ui.notify(`Created workflow: "${task}" (${state.workflowDir})`, "info");

	pi.sendUserMessage(
		`Create a high-level plan for: ${task}\n\n` +
			`Explore the codebase first, then create a plan with numbered phases.\n` +
			`Use ### Phase N: <name> headers for each phase.\n` +
			`Save the plan to ${state.workflowDir}high-level.md\n` +
			`After creating the plan, self-review it and ask me clarifying questions.\n` +
			`When the plan is ready for approval, output: [HIGH-LEVEL PLAN COMPLETE]`,
	);
}

// ── /workflow start ─────────────────────────────────────────────────────

async function handleStart(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const state = findActiveWorkflow(ctx.cwd);
	if (!state) {
		ctx.ui.notify("No workflow found. Use /workflow plan <task> first.", "error");
		return;
	}

	if (state.status !== "ready") {
		ctx.ui.notify(
			`Workflow is in "${state.status}" state. Expected "ready".\n` +
				`Use /workflow status for details.`,
			"error",
		);
		return;
	}

	if (state.phases.length === 0) {
		ctx.ui.notify("No phases found in high-level plan. Parse may have failed.", "error");
		return;
	}

	// Activate the workflow
	state.status = "active";
	state.step = "detailed_planning";
	state.currentPhaseIndex = 0;
	state.phases[0].status = "in_progress";
	saveWorkflow(ctx.cwd, state);

	const phase = state.phases[0];
	const total = state.phases.length;
	const filename = phaseFilename(0);

	pi.sendUserMessage(
		`Create a detailed implementation plan for Phase 1/${total}: ${phase.name}\n` +
			`Description: ${phase.description}\n\n` +
			`Save it to ${state.workflowDir}${filename}\n` +
			`After creating the plan, self-review it and ask clarifying questions.\n` +
			`When ready for approval, output: [DETAILED PLAN COMPLETE]`,
	);
}

// ── /workflow status ────────────────────────────────────────────────────

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
	const state = findActiveWorkflow(ctx.cwd);
	if (!state) {
		ctx.ui.notify("No active workflow.", "info");
		return;
	}

	const completed = state.phases.filter((p) => p.status === "complete").length;
	const total = state.phases.length;
	const currentPhase = state.phases[state.currentPhaseIndex];

	let msg = `Workflow: "${state.task}"\n`;
	msg += `Status: ${state.status} | Step: ${state.step}\n`;
	msg += `Progress: ${completed}/${total} phases complete\n`;
	msg += `Directory: ${state.workflowDir}\n`;

	if (currentPhase) {
		msg += `\nCurrent Phase: ${currentPhase.index + 1}. ${currentPhase.name} [${currentPhase.status}]`;
	}

	if (total > 0) {
		msg += "\n\nPhases:";
		for (const p of state.phases) {
			const icon =
				p.status === "complete" ? "✓" : p.status === "in_progress" ? "→" : "○";
			msg += `\n  ${icon} Phase ${p.index + 1}: ${p.name}`;
		}
	}

	ctx.ui.notify(msg, "info");
}

// ── /workflow abort ─────────────────────────────────────────────────────

async function handleAbort(ctx: ExtensionCommandContext): Promise<void> {
	const state = findActiveWorkflow(ctx.cwd);
	if (!state) {
		ctx.ui.notify("No active workflow to abort.", "info");
		return;
	}

	state.status = "aborted";
	saveWorkflow(ctx.cwd, state);
	ctx.ui.notify(`Workflow "${state.task}" aborted. Files preserved in ${state.workflowDir}`, "info");
}

// ── /workflow continue ──────────────────────────────────────────────────

async function handleContinue(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const state = findActiveWorkflow(ctx.cwd);
	if (!state) {
		ctx.ui.notify("No active workflow found.", "error");
		return;
	}

	// Resume based on current step
	if (state.status === "ready") {
		// Redirect to start
		return handleStart(pi, ctx);
	}

	if (state.status !== "active") {
		ctx.ui.notify(`Cannot continue workflow in "${state.status}" state.`, "error");
		return;
	}

	// Re-inject context based on current step
	const phase = state.phases[state.currentPhaseIndex];
	if (!phase) {
		ctx.ui.notify("Invalid phase index. Workflow state may be corrupted.", "error");
		return;
	}

	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;

	switch (state.step) {
		case "detailed_planning":
			pi.sendUserMessage(
				`Continue creating the detailed plan for Phase ${idx}/${total}: ${phase.name}\n` +
					`Save to ${state.workflowDir}${phaseFilename(phase.index)}\n` +
					`When ready for approval, output: [DETAILED PLAN COMPLETE]`,
			);
			break;

		case "implementing":
			pi.sendUserMessage(
				`Continue implementing Phase ${idx}/${total}: ${phase.name}\n` +
					`After implementation, perform a self-review and output: [IMPLEMENTATION REVIEW COMPLETE]`,
			);
			break;

		case "integrating":
			pi.sendUserMessage(
				`Continue integration for Phase ${idx}/${total}: ${phase.name}\n` +
					`Update the high-level plan and create the detailed plan for the next phase.\n` +
					`When the next plan is ready, output: [DETAILED PLAN COMPLETE]`,
			);
			break;

		default:
			ctx.ui.notify(`Workflow is in step "${state.step}". Try continuing your conversation.`, "info");
	}
}

// ── /workflow restart-phase ─────────────────────────────────────────────

async function handleRestartPhase(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const state = findActiveWorkflow(ctx.cwd);
	if (!state || state.status !== "active") {
		ctx.ui.notify("No active workflow to restart.", "error");
		return;
	}

	const phase = state.phases[state.currentPhaseIndex];
	if (!phase) {
		ctx.ui.notify("Invalid phase index.", "error");
		return;
	}

	// Reset phase to detailed planning
	phase.status = "in_progress";
	state.step = "detailed_planning";
	saveWorkflow(ctx.cwd, state);

	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;

	ctx.ui.notify(`Restarting Phase ${idx}: ${phase.name}`, "info");

	pi.sendUserMessage(
		`Re-plan Phase ${idx}/${total}: ${phase.name} from scratch.\n` +
			`Description: ${phase.description}\n\n` +
			`Save to ${state.workflowDir}${phaseFilename(phase.index)}\n` +
			`When ready for approval, output: [DETAILED PLAN COMPLETE]`,
	);
}

// ── /workflow _handoff (internal — triggered by extension) ──────────────

async function handleHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const state = findActiveWorkflow(ctx.cwd);
	if (!state || state.status !== "active") {
		ctx.ui.notify("No active workflow for handoff.", "error");
		return;
	}

	const prompt = buildImplementationPrompt(ctx.cwd, state);

	// Update state before handoff
	state.step = "implementing";
	saveWorkflow(ctx.cwd, state);

	// Save prompt to disk so session_start can auto-submit
	saveHandoffPrompt(ctx.cwd, state.workflowDir, prompt);

	const currentSessionFile = ctx.sessionManager.getSessionFile();

	const result = await ctx.newSession({
		parentSession: currentSessionFile,
	});

	if (result.cancelled) {
		ctx.ui.notify("Handoff cancelled.", "info");
	}
	// After newSession, we're in the new session context.
	// session_start handler will pick up the handoff prompt.
}
