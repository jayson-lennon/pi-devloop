/**
 * DevLoop — Phased workflow extension for Pi
 *
 * Drives a plan → plan-detailed → implement loop with automatic
 * session handoffs for implementation phases.
 *
 * Commands:
 *   /devloop new <task>    — Start a new devloop workflow
 *   /devloop resume <slug> — Re-attach devloop to an existing plan
 *   /devloop exit          — Exit the current devloop
 *   /devloop _implement    — (internal) Hand off to new session
 *
 * The extension shows a popup after every agent turn (when active) with
 * context-aware options based on whether the high-level plan exists on disk.
 *
 * A persistent widget shows phase progress above the editor when a devloop is active.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const ENTRY_TYPE = "devloop-state";
const WIDGET_ID = "devloop-progress";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Slugify a string: lowercase, non-alphanumeric → dash, collapse doubles */
function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/** Resolve path to a prompt file bundled with this extension */
function promptPath(name: string): string {
    const extDir = dirname(new URL(import.meta.url).pathname);
    return join(extDir, "..", "prompts", name);
}

/** Read a prompt file and replace $1 with the slug */
function assemblePrompt(filename: string, slug: string): string {
    const template = readFileSync(promptPath(filename), "utf-8");
    return template.replace(/\$1/g, slug);
}

/** Read plan.md template, replace $1, and append the user's task after ## TASK */
function assemblePlanPrompt(slug: string, task: string): string {
    let template = readFileSync(promptPath("plan.md"), "utf-8");
    template = template.replace(/\$1/g, slug);
    template = template.replace(/^---[\s\S]*?---\n*/, "");
    return template + "\n" + task;
}

/** Read plan-detailed.md template and replace $1 */
function assemblePlanDetailedPrompt(slug: string): string {
    const template = readFileSync(promptPath("plan-detailed.md"), "utf-8");
    const body = template.replace(/^---[\s\S]*?---\n*/, "");
    return body.replace(/\$1/g, slug);
}

/** Read implement.md template and replace $1 */
function assembleImplementPrompt(slug: string): string {
    const template = readFileSync(promptPath("implement.md"), "utf-8");
    const body = template.replace(/^---[\s\S]*?---\n*/, "");
    return body.replace(/\$1/g, slug);
}

/** Check if the high-level plan file exists on disk */
function planFileExists(cwd: string, slug: string): boolean {
    return existsSync(resolve(cwd, ".plans", slug, "high-level.md"));
}

/** Read the high-level plan file contents */
function readHighLevelPlan(cwd: string, slug: string): string | null {
    const path = resolve(cwd, ".plans", slug, "high-level.md");
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

// ─── Phase Parsing ───────────────────────────────────────────────────────────

interface PhaseInfo {
    index: number;
    name: string;
    done: boolean;
}

function parsePhases(planContent: string): PhaseInfo[] {
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

/** Render phase progress lines using theme colors */
function renderProgressLines(theme: Theme, slug: string, phases: PhaseInfo[], workflowStep: string, mode: "auto" | "manual"): string[] {
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

/** Check if context utilization exceeds 70% of the context window */
function isContextOverLimit(ctx: { getContextUsage(): { tokens: number; contextWindow: number } | null }): boolean {
    const usage = ctx.getContextUsage();
    if (!usage || !usage.contextWindow) return false;
    return usage.tokens / usage.contextWindow > 0.70;
}

/** Determine the next auto-loop action based on plan files on disk */
type NextStep = "plan" | "implement" | "complete";

function deriveNextStep(cwd: string, slug: string): NextStep {
    const planContent = readHighLevelPlan(cwd, slug);
    if (!planContent) return "plan"; // No plan yet — shouldn't happen in auto mode, but safe default

    const phases = parsePhases(planContent);

    // All done
    if (phases.length === 0 || phases.every((p) => p.done)) return "complete";

    // Find first incomplete phase
    const nextPhase = phases.find((p) => !p.done);
    if (!nextPhase) return "complete";

    // Check if detailed plan exists for this phase
    const detailedPath = resolve(cwd, ".plans", slug, `phase-${nextPhase.index}-detailed.md`);
    if (existsSync(detailedPath)) return "implement";

    return "plan";
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function devloopExtension(pi: ExtensionAPI): void {
    let activeSlug: string | undefined;
    let needsPlanPrefix = false;
    let autoMode = false;

    // ─── Widget management ──────────────────────────────────────────────

    function getWorkflowStatus(cwd: string): { phases: PhaseInfo[]; workflowStep: string } {
        const planContent = activeSlug ? readHighLevelPlan(cwd, activeSlug) : null;
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

    function refreshWidget(ctx: { cwd: string; hasUI: boolean; ui: any }): void {
        if (!activeSlug || !ctx.hasUI) return;

        const { phases, workflowStep } = getWorkflowStatus(ctx.cwd);
        const lines = renderProgressLines(
            ctx.ui.theme, activeSlug, phases, workflowStep,
            autoMode ? "auto" : "manual",
        );
        ctx.ui.setWidget(WIDGET_ID, lines);
    }

    function clearWidget(ctx: { hasUI: boolean; ui: any }): void {
        if (ctx.hasUI) {
            ctx.ui.setWidget(WIDGET_ID, undefined);
        }
    }

    // ─── State persistence ─────────────────────────────────────────────────

    function persistState(): void {
        pi.appendEntry(ENTRY_TYPE, {
            slug: activeSlug,
            active: !!activeSlug,
            autoMode,
        });
    }

    function clearState(ctx: { hasUI: boolean; ui: any }): void {
        activeSlug = undefined;
        needsPlanPrefix = false;
        autoMode = false;
        clearWidget(ctx);
        persistState();
    }

    // ─── Auto-loop drive logic ─────────────────────────────────────────────

    /** Drive the auto-loop: determine next step and dispatch action */
    function driveAutoLoop(ctx: { cwd: string; hasUI: boolean; ui: any; getContextUsage(): { tokens: number; contextWindow: number } | null }): void {
        if (!activeSlug) return;

        // Safety: abort if context is over 70%
        if (isContextOverLimit(ctx)) {
            const slug = activeSlug;
            autoMode = false;
            persistState();
            clearWidget(ctx);
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `Auto-loop aborted: context utilization exceeded 70% in "${slug}". Switch to manual or compact the session.`,
                    "warning",
                );
            }
            return;
        }

        const nextStep = deriveNextStep(ctx.cwd, activeSlug);

        switch (nextStep) {
            case "complete": {
                const slug = activeSlug;
                clearState(ctx);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Auto-loop complete — all phases done for "${slug}".`, "success");
                }
                return;
            }
            case "plan": {
                // Plan-detailed in current session: send prompt as user message
                pi.sendUserMessage(assemblePlanDetailedPrompt(activeSlug));
                return;
            }
            case "implement": {
                // Spawn sub-session via command dispatch
                //
                // Alternative (if deliverAs: "followUp" doesn't work from agent_end):
                //   Try without deliverAs (agent should be idle): pi.sendUserMessage("/devloop _implement")
                //   Or use pi.sendMessage with triggerTurn: pi.sendMessage({ customType: "devloop-auto-implement", content: "/devloop _implement", display: true }, { triggerTurn: true })
                pi.sendUserMessage("/devloop _implement", { deliverAs: "followUp" });
                return;
            }
        }
    }

    // ─── Session restore ──────────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        activeSlug = undefined;
        autoMode = false;

        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "custom" &&
                (entry as any).customType === ENTRY_TYPE
            ) {
                const data = (entry as any).data;
                if (data?.active && data?.slug) {
                    activeSlug = data.slug;
                    autoMode = !!data.autoMode;
                }
                break;
            }
        }

        if (activeSlug) {
            refreshWidget(ctx);
        }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    pi.registerCommand("devloop", {
        description: "DevLoop workflow commands",
        getArgumentCompletions: (prefix: string) => {
            const subcommands = [
                { value: "new ", label: "new <task> — Start a new devloop workflow" },
                { value: "resume ", label: "resume <slug> — Re-attach devloop to an existing plan" },
                { value: "exit", label: "exit — Exit the current devloop" },
            ];
            if (!prefix) return subcommands;
            return subcommands.filter((s) => s.value.startsWith(prefix));
        },
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0];
            const rest = parts.slice(1).join(" ");

            if (sub === "new") {
                await handleNew(rest, ctx);
            } else if (sub === "resume") {
                const raw = rest.trim();
                if (!raw) {
                    ctx.ui.notify("Usage: /devloop resume <task description or slug>", "warning");
                    return;
                }
                const slug = slugify(raw);
                if (!planFileExists(ctx.cwd, slug)) {
                    ctx.ui.notify(`No plan found at .plans/${slug}/high-level.md`, "error");
                    return;
                }
                activeSlug = slug;
                persistState();
                refreshWidget(ctx);
                pi.setSessionName(slug);
                ctx.ui.notify(`DevLoop resumed: **${slug}**`, "info");
            } else if (sub === "_implement") {
                await handleDoImplement(ctx);
            } else if (sub === "exit") {
                handleExit(ctx);
            } else {
                ctx.ui.notify("Usage: /devloop <new|resume|exit> [args]", "warning");
            }
        },
    });

    async function handleNew(
        task: string,
        ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
    ): Promise<void> {
        if (!task) {
            ctx.ui.notify("Usage: /devloop-new <task description>", "warning");
            return;
        }

        const slug = slugify(task);

        if (!slug) {
            ctx.ui.notify("Could not generate a slug from the task description.", "error");
            return;
        }

        if (existsSync(resolve(ctx.cwd, ".plans", slug))) {
            ctx.ui.notify(
                `Plan directory .plans/${slug}/ already exists. Start with a different name.`,
                "error",
            );
            return;
        }

        activeSlug = slug;
        persistState();
        refreshWidget(ctx);
        pi.setSessionName(slug);

        needsPlanPrefix = true;

        pi.sendMessage({
            customType: "devloop",
            content: `DevLoop started: **${slug}**\n\nDescribe your task below and press Enter.`,
            display: true,
        }, { triggerTurn: false });
    }

    function handleExit(
        ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
    ): void {
        if (!activeSlug) {
            ctx.ui.notify("No active devloop to exit.", "info");
            return;
        }
        const slug = activeSlug;
        clearState(ctx);
        ctx.ui.notify(`DevLoop "${slug}" exited.`, "info");
    }

    async function handleDoImplement(
        ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
    ): Promise<void> {
        if (!activeSlug) {
            ctx.ui.notify("No active devloop.", "error");
            return;
        }

        const slug = activeSlug;

        const highLevelPlan = readHighLevelPlan(ctx.cwd, slug);
        if (!highLevelPlan) {
            ctx.ui.notify(
                `No high-level plan found at .plans/${slug}/high-level.md. Accept the plan first.`,
                "error",
            );
            return;
        }

        const implementPrompt = assembleImplementPrompt(slug);

        const currentSessionFile = ctx.sessionManager.getSessionFile();

        const branch = ctx.sessionManager.getBranch();
        let lastAssistantMsg = "";
        for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry.type === "message" && (entry as any).message?.role === "assistant") {
                const content = (entry as any).message.content;
                if (Array.isArray(content)) {
                    lastAssistantMsg = content
                        .filter((c: any) => c.type === "text")
                        .map((c: any) => c.text)
                        .join("\n");
                } else if (typeof content === "string") {
                    lastAssistantMsg = content;
                }
                break;
            }
        }

        const fullPrompt = `Here is the high-level plan for the current workflow:

${highLevelPlan}

---

Last assistant message from the planning session:

<last_assistant_msg>

${lastAssistantMsg}

</last_assistant_msg>

---

${implementPrompt}

---

Parent session: ${currentSessionFile}
You can use the session_query tool with this path to look up decisions, discussions, or context from the planning session.`;

        const result = await ctx.newSession({
            parentSession: currentSessionFile,
            setup: async (sm) => {
                sm.appendCustomEntry(ENTRY_TYPE, { slug, active: true, autoMode: true });
            },
        });

        if (result.cancelled) {
            ctx.ui.notify("Handoff cancelled.", "info");
            return;
        }

        pi.setSessionName(slug);

        if (autoMode) {
            // Auto mode: submit the implementation prompt immediately
            //
            // Alternative (if sendUserMessage fails after newSession due to timing):
            //   Move prompt into setup callback via sm.appendMessage(), then trigger
            //   turn with pi.sendMessage({ customType: "devloop-auto", content: fullPrompt, display: true }, { triggerTurn: true })
            pi.sendUserMessage(fullPrompt);
        } else {
            // Manual mode: put prompt in editor for user to review and press Enter
            ctx.ui.setEditorText(fullPrompt);
        }
    }

    // ─── Hook: input ──────────────────────────────────────────────────────

    pi.on("input", async (event, ctx) => {
        if (!needsPlanPrefix || !activeSlug) return { action: "continue" };

        needsPlanPrefix = false;

        const userText = event.text;
        const prefix = assemblePlanPrompt(activeSlug, "");
        const combined = prefix + "\n" + userText;

        return { action: "transform", text: combined };
    });

    // ─── Popup logic (shared between agent_end, command, shortcut) ────────

    async function showDevloopPopup(ctx: { cwd: string; hasUI: boolean; ui: any; getContextUsage(): { tokens: number; contextWindow: number } | null }, paused = false): Promise<void> {
        if (!activeSlug || !ctx.hasUI) return;

        const slug = activeSlug;
        const planExists = planFileExists(ctx.cwd, slug);

        let options: string[];
        let title: string;

        if (autoMode) {
            // Auto mode popup — shown after ESC pause or via Ctrl+Q
            title = `DevLoop: ${slug} ⚙ Auto Mode\n\nPress Esc to dismiss. Use Ctrl+Q to show this popup again.`;
            options = [
                ...(paused ? ["▶ Continue auto-loop"] : []),
                "🖐 Switch to manual",
                "🚪 Exit devloop",
            ];
        } else if (!planExists) {
            // No plan yet, manual mode
            title = `DevLoop: ${slug}\n\nFlow: propose plan → accept → make detailed plan → implement → repeat\n\nPress Esc to dismiss. Use Ctrl+Q to show this popup again.`;
            options = [
                "💬 Talk to the agent",
                "✅ Accept plan",
                "✅ Accept & Auto-Implement",
                "🚪 Exit devloop",
            ];
        } else {
            // Plan exists, manual mode
            title = `DevLoop: ${slug}\n\nFlow: make detailed plan → implement → repeat\n\nPress Esc to dismiss. Use Ctrl+Q to show this popup again.`;
            options = [
                "💬 Talk to the agent",
                "📄 Make detailed plan",
                "🔨 Implement (press enter 3 times)",
                "⚡ Auto-Implement",
                "⚡ Switch to auto",
                "🚪 Exit devloop",
            ];
        }

        const choice = await ctx.ui.select(title, options);

        if (!choice || choice.startsWith("💬 Talk to the agent")) {
            return;
        }

        // ── Manual mode: no plan ──

        if (choice.startsWith("✅ Accept & Auto-Implement")) {
            autoMode = true;
            persistState();
            refreshWidget(ctx);
            pi.sendUserMessage(
                `The plan looks good. Save it to \`.plans/${slug}/high-level.md\` now.`,
                { deliverAs: "followUp" },
            );
            return;
        }

        if (choice.startsWith("✅ Accept plan")) {
            pi.sendUserMessage(
                `The plan looks good. Save it to \`.plans/${slug}/high-level.md\` now.`,
                { deliverAs: "followUp" },
            );
            return;
        }

        // ── Manual mode: plan exists ──

        if (choice.startsWith("📄 Make detailed plan")) {
            pi.sendUserMessage(assemblePlanDetailedPrompt(slug), { deliverAs: "followUp" });
            return;
        }

        if (choice.startsWith("🔨 Implement")) {
            ctx.ui.setEditorText("/devloop _implement");
            return;
        }

        if (choice.startsWith("⚡ Auto-Implement")) {
            autoMode = true;
            persistState();
            refreshWidget(ctx);
            driveAutoLoop(ctx);
            return;
        }

        if (choice.startsWith("⚡ Switch to auto")) {
            autoMode = true;
            persistState();
            refreshWidget(ctx);
            ctx.ui.notify("Auto mode enabled. The loop will drive automatically.", "info");
            return;
        }

        // ── Auto mode ──

        if (choice.startsWith("▶ Continue auto-loop")) {
            driveAutoLoop(ctx);
            return;
        }

        if (choice.startsWith("🖐 Switch to manual")) {
            autoMode = false;
            persistState();
            refreshWidget(ctx);
            ctx.ui.notify("Switched to manual mode.", "info");
            return;
        }

        // ── Common ──

        if (choice.startsWith("🚪 Exit devloop")) {
            clearState(ctx);
            ctx.ui.notify(`DevLoop "${slug}" exited.`, "info");
            return;
        }
    }

    // ─── Hook: agent_end ──────────────────────────────────────────────────

    pi.on("agent_end", async (event, ctx) => {
        refreshWidget(ctx);

        if (!activeSlug) return;

        const { workflowStep } = getWorkflowStatus(ctx.cwd);

        // Auto-exit when all phases are complete
        if (workflowStep === "complete") {
            const slug = activeSlug;
            clearState(ctx);
            ctx.ui.notify(`DevLoop "${slug}" complete — all phases done.`, "success");
            return;
        }

        // Auto mode: drive the loop (unless turn was aborted)
        if (autoMode) {
            const messages = event.messages ?? [];
            let wasAborted = false;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]?.role === "assistant") {
                    wasAborted = messages[i].stopReason === "aborted";
                    break;
                }
            }

            if (!wasAborted) {
                //
                // Alternative (if deliverAs: "followUp" doesn't work from agent_end):
                //   Try without deliverAs (agent should be idle): pi.sendUserMessage("/devloop _implement")
                //   Or use pi.sendMessage with triggerTurn: pi.sendMessage({ customType: "devloop-auto-implement", content: "/devloop _implement", display: true }, { triggerTurn: true })
                driveAutoLoop(ctx);
                return;
            }
            // Turn was aborted (user hit ESC) — paused. Show popup with "Continue" option.
            await showDevloopPopup(ctx, true);
            return;
        }

        // Manual mode: show popup
        await showDevloopPopup(ctx);
    });

    // ─── Shortcut: Ctrl+Q ────────────────────────────────────────────────────

    pi.registerShortcut(Key.ctrl("q"), {
        description: "Show devloop popup",
        handler: async (ctx) => {
            refreshWidget(ctx);
            await showDevloopPopup(ctx);
        },
    });
}
