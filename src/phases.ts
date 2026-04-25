/**
 * DevLoop — phase parsing, rendering, and workflow derivation
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readHighLevelPlan } from "./helpers.js";

// ─── Phase types ─────────────────────────────────────────────────────────────

export interface PhaseInfo {
    index: number;
    name: string;
    done: boolean;
}

/** Determine the next auto-loop action based on plan files on disk */
export type NextStep = "plan" | "implement" | "complete";

// ─── Phase parsing ───────────────────────────────────────────────────────────

export function parsePhases(planContent: string): PhaseInfo[] {
    const phases: PhaseInfo[] = [];
    const regex = /^- \[([ xX])\] (?:\*\*)?Phase (\d+):(?:\*\*)? (.+?)(?:\*\*)?$/gm;
    let match;
    while ((match = regex.exec(planContent)) !== null) {
        phases.push({
            index: parseInt(match[2]!, 10),
            name: match[3]!.trim(),
            done: match[1]!.toLowerCase() === "x",
        });
    }
    return phases;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Render phase progress lines using theme colors */
export function renderProgressLines(theme: Theme, slug: string, phases: PhaseInfo[], workflowStep: string, mode: "auto" | "manual"): string[] {
    const th = theme;
    const lines: string[] = [];

    lines.push(th.fg("accent", th.bold("DevLoop")) + th.fg("dim", `: ${slug}`));

    if (phases.length > 0) {
        const completed = phases.filter((p) => p.done).length;
        const total = phases.length;
        const barWidth = 12;
        const filled = Math.round((completed / total) * barWidth);
        const empty = barWidth - filled;
        const bar = th.fg("success", "█".repeat(filled)) + th.fg("dim", "░".repeat(empty));
        const count = th.fg("dim", `${completed}/${total}`);
        lines.push(` ${bar} ${count}`);

        for (const phase of phases) {
            const icon = phase.done ? th.fg("success", "✓") : th.fg("dim", "○");
            const name = phase.done ? th.fg("dim", phase.name) : th.fg("text", phase.name);
            const num = th.fg("accent", `P${phase.index}`);
            lines.push(` ${icon} ${num} ${name}`);
        }
    } else {
        lines.push(th.fg("dim", " No phases yet"));
    }

    const stepIcon = workflowStep === "complete" ? th.fg("success", "✓") : th.fg("warning", "⚙");
    lines.push(` ${stepIcon} ${workflowStep}`);

    const modeLabel = mode === "auto"
        ? th.fg("accent", "⚙ Auto")
        : th.fg("dim", "🖐 Manual");
    lines.push(` ${modeLabel}`);

    return lines;
}

// ─── Workflow status ─────────────────────────────────────────────────────────

/** Check if context utilization exceeds 70% of the context window */
export function isContextOverLimit(ctx: { getContextUsage(): { tokens: number; contextWindow: number } | null }): boolean {
    const usage = ctx.getContextUsage();
    if (!usage || !usage.contextWindow) return false;
    return usage.tokens / usage.contextWindow > 0.70;
}

/** Get phases and workflow step for a slug */
export function getWorkflowStatus(cwd: string, slug: string | undefined): { phases: PhaseInfo[]; workflowStep: string } {
    const planContent = slug ? readHighLevelPlan(cwd, slug) : null;
    const phases = planContent ? parsePhases(planContent) : [];

    let workflowStep: string;
    if (phases.length === 0) {
        workflowStep = "planning";
    } else if (phases.every((p) => p.done)) {
        workflowStep = "complete";
    } else {
        workflowStep = "implementing";
    }

    return { phases, workflowStep };
}

/** Derive the next auto-loop step based on plan files on disk */
export function deriveNextStep(cwd: string, slug: string): NextStep {
    const planContent = readHighLevelPlan(cwd, slug);
    if (!planContent) return "plan";

    const phases = parsePhases(planContent);

    if (phases.length === 0 || phases.every((p) => p.done)) return "complete";

    const nextPhase = phases.find((p) => !p.done);
    if (!nextPhase) return "complete";

    const detailedPath = resolve(cwd, ".plans", slug, `phase-${nextPhase.index}-detailed.md`);
    if (existsSync(detailedPath)) return "implement";

    return "plan";
}
