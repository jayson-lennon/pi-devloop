import type { PhaseInfo, WorkflowState } from "./types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Slugify ─────────────────────────────────────────────────────────────

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
}

// ── Path Helpers ────────────────────────────────────────────────────────

export function getPlansDir(cwd: string): string {
	return join(cwd, ".plans");
}

export function getWorkflowDir(cwd: string, slug: string): string {
	return join(getPlansDir(cwd), slug);
}

export function getStateFile(cwd: string, slug: string): string {
	return join(getWorkflowDir(cwd, slug), "workflow.json");
}

// ── Find Active Workflow ────────────────────────────────────────────────

export function findActiveWorkflow(cwd: string): WorkflowState | null {
	const plansDir = getPlansDir(cwd);
	if (!existsSync(plansDir)) return null;

	const entries = readdirSync(plansDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const stateFile = join(plansDir, entry.name, "workflow.json");
		if (!existsSync(stateFile)) continue;

		try {
			const raw = readFileSync(stateFile, "utf8");
			const state: WorkflowState = JSON.parse(raw);
			if (state.status !== "complete" && state.status !== "aborted") {
				return state;
			}
		} catch {
			// Corrupted state file — skip
		}
	}

	return null;
}

// ── Create Workflow ─────────────────────────────────────────────────────

export function createWorkflow(cwd: string, task: string): WorkflowState {
	const slug = slugify(task);
	const dir = getWorkflowDir(cwd, slug);

	// Handle collision
	let finalSlug = slug;
	let finalDir = dir;
	let counter = 1;
	while (existsSync(finalDir)) {
		finalSlug = `${slug}-${counter}`;
		finalDir = getWorkflowDir(cwd, finalSlug);
		counter++;
	}

	mkdirSync(finalDir, { recursive: true });

	const now = Date.now();
	const state: WorkflowState = {
		task,
		slug: finalSlug,
		workflowDir: `.plans/${finalSlug}/`,
		status: "planning",
		step: "high_level_planning",
		currentPhaseIndex: 0,
		phases: [],
		createdAt: now,
		updatedAt: now,
	};

	writeFileSync(join(finalDir, "workflow.json"), JSON.stringify(state, null, 2), "utf8");
	writeFileSync(join(finalDir, "high-level.md"), "", "utf8");

	return state;
}

// ── Load / Save State ───────────────────────────────────────────────────

export function loadWorkflow(cwd: string, slug: string): WorkflowState | null {
	const stateFile = getStateFile(cwd, slug);
	if (!existsSync(stateFile)) return null;

	try {
		const raw = readFileSync(stateFile, "utf8");
		return JSON.parse(raw) as WorkflowState;
	} catch {
		return null;
	}
}

export function loadWorkflowByDir(cwd: string, workflowDir: string): WorkflowState | null {
	const stateFile = resolve(cwd, workflowDir, "workflow.json");
	if (!existsSync(stateFile)) return null;

	try {
		const raw = readFileSync(stateFile, "utf8");
		return JSON.parse(raw) as WorkflowState;
	} catch {
		return null;
	}
}

export function saveWorkflow(cwd: string, state: WorkflowState): void {
	const stateFile = resolve(cwd, state.workflowDir, "workflow.json");
	state.updatedAt = Date.now();
	writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

// ── Plan File I/O ───────────────────────────────────────────────────────

export function loadPlanFile(cwd: string, workflowDir: string, filename: string): string | null {
	const filePath = resolve(cwd, workflowDir, filename);
	if (!existsSync(filePath)) return null;
	return readFileSync(filePath, "utf8");
}

export function savePlanFile(cwd: string, workflowDir: string, filename: string, content: string): void {
	const filePath = resolve(cwd, workflowDir, filename);
	writeFileSync(filePath, content, "utf8");
}

// ── Handoff Prompt File ─────────────────────────────────────────────────

export function saveHandoffPrompt(cwd: string, workflowDir: string, prompt: string): void {
	savePlanFile(cwd, workflowDir, ".handoff-prompt", prompt);
}

export function loadAndDeleteHandoffPrompt(cwd: string, workflowDir: string): string | null {
	const prompt = loadPlanFile(cwd, workflowDir, ".handoff-prompt");
	if (prompt !== null) {
		const filePath = resolve(cwd, workflowDir, ".handoff-prompt");
		rmSync(filePath);
	}
	return prompt;
}

// ── Parse Phases from Plan ──────────────────────────────────────────────

export function parsePhasesFromPlan(markdown: string): PhaseInfo[] {
	const phases: PhaseInfo[] = [];
	const lines = markdown.split("\n");

	for (const line of lines) {
		// Match ### Phase N: <name> or ## Phase N: <name> or ### Phase N - <name>
		const match = line.match(/^#{2,4}\s+Phase\s+(\d+)\s*[:\-–—]\s*(.+)/i);
		if (match) {
			const index = parseInt(match[1], 10) - 1; // Convert to 0-based
			const name = match[2].trim();
			phases.push({
				index,
				name,
				description: "",
				status: "pending",
			});
		}
	}

	// Extract descriptions (text between phase headers)
	for (let i = 0; i < phases.length; i++) {
		const phaseHeader = `Phase ${phases[i].index + 1}`;
		const nextHeader =
			i + 1 < phases.length ? `Phase ${phases[i + 1].index + 1}` : null;

		const startIdx = markdown.indexOf(phaseHeader);
		if (startIdx === -1) continue;

		const endIdx = nextHeader ? markdown.indexOf(nextHeader, startIdx + 1) : markdown.length;
		const section = markdown.slice(startIdx, endIdx);

		// Take the text after the header line as description
		const sectionLines = section.split("\n").slice(1);
		const desc = sectionLines
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"))
			.join(" ")
			.slice(0, 500);

		phases[i].description = desc;
	}

	return phases;
}

// ── Phase File Name ─────────────────────────────────────────────────────

export function phaseFilename(phaseIndex: number): string {
	return `phase-${phaseIndex + 1}-detailed.md`;
}
