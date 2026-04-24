// ── Workflow Status ─────────────────────────────────────────────────────

export type WorkflowStatus =
	| "planning" // Flow A: creating high-level plan
	| "ready" // Flow A complete, awaiting /workflow start
	| "active" // Flow B: in the loop
	| "complete" // All phases done
	| "aborted";

// ── Workflow Step ───────────────────────────────────────────────────────

export type WorkflowStep =
	| "high_level_planning" // Agent is creating/iterating on high-level plan
	| "detailed_planning" // Agent is creating/iterating on detailed plan
	| "implementing" // Agent is implementing a phase
	| "integrating" // Agent is updating high-level plan + generating next detailed plan
	| "done";

// ── Phase Info ──────────────────────────────────────────────────────────

export interface PhaseInfo {
	index: number; // 0-based
	name: string;
	description: string;
	status: "pending" | "in_progress" | "complete";
	detailedPlanFile?: string; // e.g. "phase-1-detailed.md"
}

// ── Workflow State ──────────────────────────────────────────────────────

export interface WorkflowState {
	task: string;
	slug: string;
	workflowDir: string; // relative: .plans/<slug>/
	status: WorkflowStatus;
	step: WorkflowStep;
	currentPhaseIndex: number;
	phases: PhaseInfo[];
	createdAt: number;
	updatedAt: number;
}

// ── Markers ─────────────────────────────────────────────────────────────

export type MarkerType =
	| "high_level_plan"
	| "detailed_plan"
	| "implementation_review"
	| "blocked"
	| "workflow_complete"
	| "done";

export interface DetectedMarker {
	type: MarkerType;
	data?: string; // Reason for blocked, step number for done
}

// ── Decision Gates ──────────────────────────────────────────────────────

export type GateAction =
	| "approve"
	| "revise"
	| "restart"
	| "abort"
	| "edit_plan"
	| "skip";

export interface GateResult {
	action: GateAction;
	feedback?: string;
}
