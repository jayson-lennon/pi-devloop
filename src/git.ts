import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { WorkflowState } from "./types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

/**
 * Check if the cwd is inside a git repository.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
		return true;
	} catch {
		return false;
	}
}

/**
 * Auto-commit all changes after a phase is reviewed.
 * Commit message format: "phase N/M: <phase name>"
 *
 * Returns a status message for the caller to display.
 */
export async function commitPhase(
	pi: ExtensionAPI,
	cwd: string,
	state: WorkflowState,
): Promise<string> {
	const isGit = await isGitRepo(cwd);
	if (!isGit) {
		return "Not a git repo — skipping auto-commit";
	}

	const phase = state.phases[state.currentPhaseIndex];
	const total = state.phases.length;
	const idx = state.currentPhaseIndex + 1;
	const message = `phase ${idx}/${total}: ${phase.name}`;

	try {
		await pi.exec("git", ["add", "-A"], { cwd });

		// Check if there's anything to commit
		const status = await pi.exec("git", ["status", "--porcelain"], { cwd });
		if (!status.stdout.trim()) {
			return "No changes to commit";
		}

		await pi.exec("git", ["commit", "-m", message], { cwd });
		return `Committed: ${message}`;
	} catch (err) {
		return `Git commit failed: ${err}`;
	}
}
