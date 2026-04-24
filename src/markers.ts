import type { DetectedMarker } from "./types.js";

const MARKERS = {
	HIGH_LEVEL_PLAN: /\[HIGH-LEVEL PLAN COMPLETE\]/i,
	DETAILED_PLAN: /\[DETAILED PLAN COMPLETE\]/i,
	IMPLEMENTATION_REVIEW: /\[IMPLEMENTATION REVIEW COMPLETE\]/i,
	BLOCKED: /\[BLOCKED:\s*(.+?)\]/is,
	WORKFLOW_COMPLETE: /\[WORKFLOW COMPLETE\]/i,
	DONE: /\[DONE:(\d+)\]/i,
} as const;

/**
 * Detect workflow markers in assistant message text.
 * Returns all markers found, in priority order.
 * "blocked" and "workflow_complete" take precedence.
 */
export function detectMarkers(text: string): DetectedMarker[] {
	const markers: DetectedMarker[] = [];

	// Check blocked first — highest priority
	const blockedMatch = text.match(MARKERS.BLOCKED);
	if (blockedMatch) {
		markers.push({ type: "blocked", data: blockedMatch[1].trim() });
	}

	if (MARKERS.HIGH_LEVEL_PLAN.test(text)) {
		markers.push({ type: "high_level_plan" });
	}

	if (MARKERS.DETAILED_PLAN.test(text)) {
		markers.push({ type: "detailed_plan" });
	}

	if (MARKERS.IMPLEMENTATION_REVIEW.test(text)) {
		markers.push({ type: "implementation_review" });
	}

	if (MARKERS.WORKFLOW_COMPLETE.test(text)) {
		markers.push({ type: "workflow_complete" });
	}

	// Extract all [DONE:n] markers
	const doneMatches = text.matchAll(/\[DONE:(\d+)\]/gi);
	for (const match of doneMatches) {
		markers.push({ type: "done", data: match[1] });
	}

	return markers;
}

/**
 * Get the highest-priority actionable marker (ignoring [DONE:n] progress markers).
 */
export function getPrimaryMarker(markers: DetectedMarker[]): DetectedMarker | null {
	// Priority: blocked > workflow_complete > implementation_review > detailed_plan > high_level_plan
	const priority: Array<DetectedMarker["type"]> = [
		"blocked",
		"workflow_complete",
		"implementation_review",
		"detailed_plan",
		"high_level_plan",
	];

	for (const p of priority) {
		const found = markers.find((m) => m.type === p);
		if (found) return found;
	}

	return null;
}

/**
 * Extract text content from an assistant message's content blocks.
 */
export function extractTextFromMessage(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
