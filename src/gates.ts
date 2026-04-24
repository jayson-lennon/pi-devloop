import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GateResult, PhaseInfo, WorkflowState } from "./types.js";

// ── Gate: High-Level Plan Review ────────────────────────────────────────

export async function gatePlanReview(ctx: ExtensionContext): Promise<GateResult> {
	const choice = await ctx.ui.select("High-level plan review:", [
		"✅ Approve — save plan and prepare for implementation",
		"✏️ Revise — I have feedback",
		"❌ Abort workflow",
	]);

	if (!choice) return { action: "abort" };

	if (choice.startsWith("✅")) return { action: "approve" };
	if (choice.startsWith("✏️")) {
		const feedback = await ctx.ui.editor("Plan feedback:", "");
		return { action: "revise", feedback: feedback ?? undefined };
	}
	return { action: "abort" };
}

// ── Gate: Detailed Plan Review ──────────────────────────────────────────

export async function gateDetailedPlanReview(
	ctx: ExtensionContext,
	phase: PhaseInfo,
	phaseIndex: number,
	totalPhases: number,
): Promise<GateResult> {
	const label = `Phase ${phaseIndex + 1}/${totalPhases}: ${phase.name}`;
	const choice = await ctx.ui.select(`Detailed plan review — ${label}`, [
		"✅ Approve — proceed to implementation",
		"✏️ Revise — I have feedback",
		"🔄 Re-plan this phase from scratch",
		"❌ Abort workflow",
	]);

	if (!choice) return { action: "abort" };

	if (choice.startsWith("✅")) return { action: "approve" };
	if (choice.startsWith("✏️")) {
		const feedback = await ctx.ui.editor("Detailed plan feedback:", "");
		return { action: "revise", feedback: feedback ?? undefined };
	}
	if (choice.startsWith("🔄")) return { action: "restart" };
	return { action: "abort" };
}

// ── Gate: Implementation Review ─────────────────────────────────────────

export async function gateImplementationReview(
	ctx: ExtensionContext,
	phase: PhaseInfo,
	phaseIndex: number,
	totalPhases: number,
): Promise<GateResult> {
	const label = `Phase ${phaseIndex + 1}/${totalPhases}: ${phase.name}`;
	const choice = await ctx.ui.select(`Implementation review — ${label}`, [
		"✅ Looks good — integrate and continue",
		"✏️ Minor issues — describe them and continue",
		"🔄 Restart this phase (re-plan from scratch)",
		"❌ Abort workflow",
	]);

	if (!choice) return { action: "abort" };

	if (choice.startsWith("✅")) return { action: "approve" };
	if (choice.startsWith("✏️")) {
		const feedback = await ctx.ui.editor("Describe the issues:", "");
		return { action: "revise", feedback: feedback ?? undefined };
	}
	if (choice.startsWith("🔄")) return { action: "restart" };
	return { action: "abort" };
}

// ── Gate: Blocked ───────────────────────────────────────────────────────

export async function gateBlocked(
	ctx: ExtensionContext,
	reason: string,
	phase: PhaseInfo,
): Promise<GateResult> {
	const choice = await ctx.ui.select(
		`🚫 Implementation blocked: ${reason}`,
		[
			"✏️ Provide guidance and retry",
			"🔄 Restart this phase (re-plan from scratch)",
			"⏭️ Skip this phase",
			"❌ Abort workflow",
		],
	);

	if (!choice) return { action: "abort" };

	if (choice.startsWith("✏️")) {
		const guidance = await ctx.ui.editor("Guidance for the agent:", "");
		return { action: "revise", feedback: guidance ?? undefined };
	}
	if (choice.startsWith("🔄")) return { action: "restart" };
	if (choice.startsWith("⏭️")) return { action: "skip" };
	return { action: "abort" };
}

// ── Gate: Next Phase (with escape hatch) ────────────────────────────────

export async function gateNextPhase(
	ctx: ExtensionContext,
	state: WorkflowState,
	nextPhase: PhaseInfo,
): Promise<GateResult> {
	const total = state.phases.length;
	const nextIdx = state.currentPhaseIndex + 1;
	const isLast = nextIdx >= total - 1;

	const choices = [
		"✅ Approve — continue to implementation",
		"✏️ Revise detailed plan",
		"🔄 Restart this phase (re-plan from scratch)",
	];

	// Escape hatch: option to edit high-level plan
	if (!isLast) {
		choices.push("📝 Edit high-level plan before continuing");
	}

	choices.push("❌ Abort workflow");

	const label = `Next phase plan — Phase ${nextIdx + 1}/${total}: ${nextPhase.name}`;
	const choice = await ctx.ui.select(label, choices);

	if (!choice) return { action: "abort" };

	if (choice.startsWith("✅")) return { action: "approve" };
	if (choice.startsWith("✏️")) {
		const feedback = await ctx.ui.editor("Detailed plan feedback:", "");
		return { action: "revise", feedback: feedback ?? undefined };
	}
	if (choice.startsWith("🔄")) return { action: "restart" };
	if (choice.startsWith("📝")) return { action: "edit_plan" };
	return { action: "abort" };
}
