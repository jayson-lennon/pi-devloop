/**
 * DevLoop — Phased workflow extension for Pi
 *
 * Drives a plan → plan-detailed → implement loop with automatic
 * session handoffs for implementation phases.
 *
 * Commands:
 *   /devloop new <task>    — Start a new devloop workflow
 *
 * The extension shows a popup after every agent turn (when active) with
 * context-aware options based on whether the high-level plan exists on disk.
 *
 * A persistent widget shows phase progress above the editor when a devloop is active.
 *
 * ── Architecture: Why the event bus + cachedCmdCtx pattern? ──────────────
 *
 * Pi extensions have TWO context types with different capabilities:
 *
 *   ExtensionContext     — available in event hooks (agent_end, session_start, etc.)
 *                          Has: cwd, ui, getContextUsage()
 *                          Lacks: newSession(), sendUserMessage()
 *
 *   ExtensionCommandContext — available in /command handlers
 *                             Has everything ExtensionContext has, PLUS:
 *                             newSession(), sessionManager, model, isIdle()
 *
 * The auto-loop needs to call newSession() when it's time to implement, but
 * it's triggered from agent_end which only gives us ExtensionContext.
 *
 * APPROACHES THAT DO NOT WORK:
 *
 *   ❌ pi.sendUserMessage("/devloop _implement")
 *      sendUserMessage sends raw TEXT, not a command. Pi does NOT re-parse
 *      user messages as slash commands. The text literally goes to the LLM
 *      as if the user typed it — the LLM sees "/devloop _implement" and has
 *      no idea what to do with it.
 *
 *   ❌ Calling ctx.newSession() from inside an agent_end handler
 *      agent_end gives ExtensionContext, not ExtensionCommandContext.
 *      newSession() only exists on ExtensionCommandContext. TypeScript won't
 *      even compile this.
 *
 *   ❌ Using pi.sendMessage() with triggerTurn to invoke the command
 *      sendMessage sends a custom/assistant-style message, not a command.
 *      It doesn't route through the command handler.
 *
 * WHAT WORKS: The event bus bridge.
 *
 *   1. Every /devloop command handler runs, we cache its ctx as cachedCmdCtx.
 *      This is a ExtensionCommandContext — it has newSession().
 *
 *   2. When agent_end fires and driveAutoLoop needs to implement, it emits
 *      pi.events.emit("devloop:implement", { slug }).
 *
 *   3. The event handler (registered during setup) calls
 *      handleDoImplement(cachedCmdCtx) — using the cached command context
 *      which HAS newSession().
 *
 *   4. handleDoImplement calls ctx.newSession() on that cached context.
 *
 * This is ugly but necessary given Pi's context split. The handoff.ts
 * example in Pi's examples directory does the same thing (minus the event
 * bus, because it's user-triggered from a command, not auto-triggered from
 * an event hook).
 *
 * ── Session replacement: The withSession minefield ──────────────────────
 *
 * ctx.newSession() does NOT simply return a new context. It REPLACES the
 * current session. After it completes:
 *
 *   - The old session is destroyed (session_shutdown fires)
 *   - A new session is created (session_start fires)
 *   - The old pi object and old ctx are STALE — any session-bound call
 *     on them will THROW
 *
 * DO NOT DO THESE THINGS after ctx.newSession() resolves:
 *
 *   ❌ pi.sendUserMessage(prompt)        — stale pi, throws
 *   ❌ pi.setSessionName(name)            — stale pi, throws
 *   ❌ ctx.ui.setEditorText(text)          — stale ctx, throws
 *   ❌ ctx.sessionManager.anything()       — stale ctx, throws
 *
 * INSTEAD, use the withSession callback:
 *
 *   await ctx.newSession({
 *       setup: async (sm) => { ... },      // runs before replacement
 *       withSession: async (newCtx) => {    // newCtx is fresh
 *           await newCtx.sendUserMessage(prompt);  // ✅ works
 *           newCtx.ui.setEditorText(text);          // ✅ works
 *           // pi.setSessionName(name);             // ❌ STILL stale pi!
 *       },
 *   });
 *
 * IMPORTANT: Even inside withSession, the captured `pi` is stale.
 * Only `newCtx` (the ReplacedSessionContext) is safe. It extends
 * ExtensionCommandContext with sendUserMessage() and sendMessage().
 * But it does NOT have setSessionName — that's only on `pi`.
 *
 * This is why handleDoImplement does NOT call pi.setSessionName() inside
 * withSession. We traded the cosmetic session name for actually working
 * prompt delivery. If Pi adds setSessionName to ReplacedSessionContext
 * in the future, we can restore it.
 *
 * ── State persistence across sessions ───────────────────────────────────
 *
 * Extension closure state (activeSlug, autoMode, etc.) is per-instance.
 * When a new session is created, a NEW extension instance is created and
 * the old one is destroyed. State survives via:
 *
 *   1. setup callback: sm.appendCustomEntry() writes state into the new
 *      session's entry log before it goes live.
 *
 *   2. session_start handler: reads the custom entry back out and
 *      restores activeSlug/autoMode.
 *
 *   3. withSession: captures shouldAutoSubmit BEFORE the session switch
 *      (because session_start in the NEW instance resets closure state).
 *      The captured boolean is plain data — it survives the closure
 *      boundary fine since withSession runs in the ORIGINAL closure.
 *
 * ── Permanent session binding ───────────────────────────────────────────
 *
 * Once a session is bound to a devloop slug (via /devloop new), it is
 * PERMANENTLY a devloop session. There is no "exit" or "pause" concept.
 * The slug persists in the custom entry forever. When the devloop completes
 * all phases, the popup shows "Implementation complete" with just a "talk
 * to agent" option. The user can keep chatting in the session normally.
 *
 * Returning to a devloop session is handled by Pi's built-in /resume — the
 * session_start handler automatically restores the slug and widget from the
 * custom entry. No separate /devloop resume command is needed.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
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
    // ── Mutable extension state (per-instance) ──────────────────────────
    //
    // These are NOT automatically carried across session replacements.
    // See the module-level doc "State persistence across sessions" for how
    // state survives via custom entries + session_start restore.
    //
    // activeSlug is PERMANENT — once set by /devloop new, it never clears.
    // A session is forever a devloop session. There is no exit/pause.
    //
    let activeSlug: string | undefined;
    let needsPlanPrefix = false;
    let autoMode = false;

    // cachedCmdCtx: the most recent ExtensionCommandContext from a /devloop
    // command invocation. This is the ONLY way to get a context that has
    // newSession() from inside event hooks like agent_end.
    //
    // WHY: agent_end gives ExtensionContext (no newSession). Command handlers
    // give ExtensionCommandContext (has newSession). We cache the command
    // context so event handlers can use it later.
    //
    // CAVEAT: This context becomes stale after session replacement.
    // It must only be used BEFORE ctx.newSession() is called, or inside
    // the withSession callback via the newCtx parameter (not this cache).
    //
    let cachedCmdCtx: ExtensionCommandContext | undefined;

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

    /** Mark devloop as complete — slug stays bound, auto/manual mode off */
    function markComplete(ctx: { hasUI: boolean; ui: any }): void {
        autoMode = false;
        needsPlanPrefix = false;
        cachedCmdCtx = undefined;
        persistState();  // writes { slug, active: true, autoMode: false } — slug persists
        refreshWidget(ctx);
    }

    // ─── Auto-loop drive logic ─────────────────────────────────────────────
    //
    // driveAutoLoop is called from agent_end when autoMode is true.
    // It determines the next step (plan / implement / complete) and dispatches.
    //
    // For "plan" and "complete", it can act directly (sendUserMessage or markComplete).
    //
    // For "implement", it CANNOT call ctx.newSession() directly because:
    //   - The ctx passed to agent_end is ExtensionContext, not ExtensionCommandContext
    //   - newSession() only exists on ExtensionCommandContext
    //
    // Instead, it emits an event via pi.events.emit("devloop:implement").
    // The event handler (registered above) picks it up and calls
    // handleDoImplement(cachedCmdCtx) which HAS the right context type.
    //
    // This indirection is the entire reason the event bus pattern exists.
    // See module-level doc for the full explanation.
    //

    /** Drive the auto-loop: determine next step and dispatch action */
    function driveAutoLoop(ctx: { cwd: string; hasUI: boolean; ui: any; getContextUsage(): { tokens: number; contextWindow: number } | null }): void {
        if (!activeSlug) return;

        // Safety: abort if context is over 70%
        if (isContextOverLimit(ctx)) {
            const slug = activeSlug;
            autoMode = false;
            persistState();
            refreshWidget(ctx);
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
                markComplete(ctx);
                if (ctx.hasUI) {
                    ctx.ui.notify(`Auto-loop complete — all phases done for "${activeSlug}".`, "success");
                }
                return;
            }
            case "plan": {
                // Plan-detailed in current session: send prompt as user message
                pi.sendUserMessage(assemblePlanDetailedPrompt(activeSlug));
                return;
            }
            case "implement": {
                // Spawn sub-session via event bus → command handler bridge.
                // agent_end only has ExtensionContext, can't call newSession().
                // Emit event so the cached command context can handle it.
                pi.events.emit("devloop:implement", { slug: activeSlug });
                return;
            }
        }
    }

    // ─── Event bus handlers ─────────────────────────────────────────────────
    //
    // These handlers are the bridge between the UI (popup actions, agent_end)
    // and the command handlers that have the right context types.
    //
    // Popup actions → emit event → event handler uses cachedCmdCtx → calls
    //   the actual handler function.
    //
    // WHY NOT just call the handler directly from the popup?
    //   The popup runs inside agent_end's ctx (ExtensionContext).
    //   Most popup actions only need pi.sendUserMessage() which works from
    //   anywhere. But "implement" needs cachedCmdCtx.newSession().
    //   Using events for ALL popup actions keeps the pattern consistent.
    //

    pi.events.on("devloop:accept-plan", () => {
        if (!activeSlug) return;
        pi.sendUserMessage(
            `The plan looks good. Save it to \`.plans/${activeSlug}/high-level.md\` now.`,
            { deliverAs: "followUp" },
        );
    });

    pi.events.on("devloop:accept-and-auto", () => {
        if (!activeSlug) return;
        autoMode = true;
        persistState();
        if (cachedCmdCtx) refreshWidget(cachedCmdCtx);
        pi.sendUserMessage(
            `The plan looks good. Save it to \`.plans/${activeSlug}/high-level.md\` now.`,
            { deliverAs: "followUp" },
        );
    });

    pi.events.on("devloop:plan-detailed", () => {
        if (!activeSlug) return;
        pi.sendUserMessage(assemblePlanDetailedPrompt(activeSlug), { deliverAs: "followUp" });
    });

    pi.events.on("devloop:implement", async (data) => {
        const { slug } = data as { slug: string };
        if (!cachedCmdCtx || !activeSlug || activeSlug !== slug) return;
        await handleDoImplement(cachedCmdCtx);
    });

    // "Auto mode" — enables auto + drives the loop immediately.
    // Consolidates the old "auto-implement", "switch-auto", and "continue-auto"
    // events into a single action: "take it from here."
    pi.events.on("devloop:auto", () => {
        if (!activeSlug) return;
        autoMode = true;
        persistState();
        if (cachedCmdCtx) refreshWidget(cachedCmdCtx);
        driveAutoLoop(cachedCmdCtx ?? { cwd: "", hasUI: false, ui: null, getContextUsage: () => null });
    });

    // "Manual mode" — disables auto, user drives via popup.
    pi.events.on("devloop:manual", () => {
        autoMode = false;
        persistState();
        if (cachedCmdCtx) {
            refreshWidget(cachedCmdCtx);
            cachedCmdCtx.ui.notify("Switched to manual mode.", "info");
        }
    });

    // ─── Session restore ──────────────────────────────────────────────────
    //
    // session_start fires for EVERY new session — including the replacement
    // session created by ctx.newSession(). When a new session is created,
    // Pi instantiates a NEW extension instance, so all closure state is gone.
    //
    // This handler restores state by reading the custom entry that was written
    // in the setup callback of ctx.newSession(). It scans entries in reverse
    // to find the most recent devloop-state entry.
    //
    // IMPORTANT: We ALWAYS restore the slug — even when active is false.
    // A session is permanently a devloop session. The slug binding never goes
    // away. Only autoMode toggles. This means returning to a completed
    // devloop session (via Pi's /resume) restores the widget in its final state.
    //
    // LIFECYCLE during session replacement:
    //   1. ctx.newSession() is called (in handleDoImplement)
    //   2. setup(sm) runs — sm.appendCustomEntry writes { slug, active: true, autoMode: true }
    //   3. Old session emits session_shutdown, is torn down
    //   4. New session is created, rebound
    //   5. NEW extension instance created → session_start fires → THIS HANDLER
    //   6. We read back the custom entry → restore activeSlug, autoMode
    //   7. withSession callback runs (in the ORIGINAL closure, with shouldAutoSubmit)
    //
    // Step 7 is why shouldAutoSubmit is captured BEFORE ctx.newSession() —
    // by the time withSession runs, this handler has already reset and
    // restored autoMode in the NEW instance, but withSession runs in the
    // OLD instance's closure where shouldAutoSubmit was captured.
    //

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
                // Always restore slug — even if active is false.
                // The session is permanently bound to this devloop.
                if (data?.slug) {
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
    //
    // The /devloop command handler is the entry point for all user-triggered
    // actions AND the place where we cache the ExtensionCommandContext.
    //
    // Only one subcommand exists: /devloop new <task>
    // All other interaction happens via the popup (Ctrl+Q) or auto-loop.
    //

    pi.registerCommand("devloop", {
        description: "DevLoop workflow commands",
        getArgumentCompletions: (prefix: string) => {
            const subcommands = [
                { value: "new ", label: "new <task> — Start a new devloop workflow" },
            ];
            if (!prefix) return subcommands;
            return subcommands.filter((s) => s.value.startsWith(prefix));
        },
        handler: async (args, ctx) => {
            // CRITICAL: Cache the command context on every invocation.
            // This is the only reliable source of ExtensionCommandContext
            // (which has newSession) for use in event handlers later.
            cachedCmdCtx = ctx;
            const parts = args.trim().split(/\s+/);
            const sub = parts[0];
            const rest = parts.slice(1).join(" ");

            if (sub === "new") {
                await handleNew(rest, ctx);
            } else {
                ctx.ui.notify("Usage: /devloop new <task description>", "warning");
            }
        },
    });

    async function handleNew(
        task: string,
        ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
    ): Promise<void> {
        if (!task) {
            ctx.ui.notify("Usage: /devloop new <task description>", "warning");
            return;
        }

        // Reject if this session is already bound to a devloop.
        // Sessions are permanently bound — use a new Pi session for a different devloop.
        if (activeSlug) {
            ctx.ui.notify(
                `This session is already bound to devloop "${activeSlug}". Start a new Pi session for a different devloop.`,
                "warning",
            );
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

    // ─── handleDoImplement: Session handoff ────────────────────────────
    //
    // This is the most dangerous function in the extension. It calls
    // ctx.newSession() which replaces the current session. After that
    // point, the old `pi` and old `ctx` are STALE and will THROW if used
    // for any session-bound operation.
    //
    // THINGS THAT HAVE BEEN TRIED AND FAILED:
    //
    //   ❌ pi.sendUserMessage(fullPrompt) after ctx.newSession()
    //      → stale pi, throws. Message never appears in new session.
    //      The process may crash or silently fail depending on the error.
    //
    //   ❌ pi.setSessionName(slug) inside withSession callback
    //      → stale pi, throws. This was the bug that caused pi to exit
    //      completely during auto-implement. The exception was unhandled
    //      inside the withSession async callback and killed the process.
    //
    //   ❌ ctx.ui.setEditorText(fullPrompt) after ctx.newSession()
    //      → stale ctx, throws. Same category as stale pi.
    //
    //   ❌ pi.sendMessage({ ... }, { triggerTurn: true }) after newSession
    //      → stale pi, throws.
    //
    //   ❌ Not using withSession at all, just hoping newSession works
    //      → new session is created but empty. No prompt delivered.
    //      sendUserMessage on stale objects silently fails or crashes.
    //
    // WHAT WORKS: The withSession pattern (see handoff.ts example in Pi).
    //
    //   await ctx.newSession({
    //       setup: async (sm) => { sm.appendCustomEntry(...) },
    //       withSession: async (newCtx) => {
    //           await newCtx.sendUserMessage(fullPrompt);  // ✅
    //           newCtx.ui.setEditorText(fullPrompt);        // ✅
    //           // pi.setSessionName(slug);                  // ❌ STILL STALE
    //       },
    //   });
    //
    // The withSession callback receives a fresh ReplacedSessionContext
    // (newCtx) that is bound to the new session. Only use newCtx.
    //
    // Trade-off: We can't set the session name because pi.setSessionName
    // is on the stale pi object and ReplacedSessionContext doesn't have it.
    // Prompt delivery > cosmetic session name.
    //
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

        // Capture autoMode BEFORE session switch.
        //
        // withSession runs AFTER session_start, which means:
        //   1. New extension instance created
        //   2. session_start handler fires → resets activeSlug/autoMode → reads
        //      custom entry back → restores autoMode = true in NEW instance
        //   3. withSession fires in ORIGINAL instance closure
        //
        // But closure `autoMode` in the ORIGINAL instance may have been
        // reset by the old instance's session_start or shutdown. So we
        // capture it here as a plain boolean (shouldAutoSubmit) which is
        // just stack data — it survives fine across the closure boundary.
        const shouldAutoSubmit = autoMode;

        const result = await ctx.newSession({
            parentSession: currentSessionFile,
            setup: async (sm) => {
                sm.appendCustomEntry(ENTRY_TYPE, { slug, active: true, autoMode: true });
            },
            withSession: async (newCtx) => {
                // withSession runs after session replacement: old pi/ctx are stale.
                // Use only newCtx for session-bound work.
                //
                // NOTE: pi.setSessionName(slug) would throw here — pi is stale.
                // Session name is less important than getting the prompt delivered.

                if (shouldAutoSubmit) {
                    await newCtx.sendUserMessage(fullPrompt);
                } else {
                    newCtx.ui.setEditorText(fullPrompt);
                }
            },
        });

        if (result.cancelled) {
            ctx.ui.notify("Handoff cancelled.", "info");
            return;
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

    // ─── Popup logic ─────────────────────────────────────────────────────
    //
    // The popup shows context-aware options after every agent turn.
    // Options depend on the current state: what files exist on disk,
    // whether auto mode is on, and whether all phases are complete.
    //
    // There are four popup states:
    //
    //   COMPLETE (all phases done):
    //     Title says "Implementation complete". Only option is "talk to agent."
    //     The widget stays visible showing all phases checked off.
    //
    //   AUTO (auto mode on, phases remain):
    //     Only option is "switch to manual." Auto drives itself.
    //
    //   PRE-PLAN (manual, no high-level plan on disk yet):
    //     Accept the plan (with or without auto), or talk to agent.
    //
    //   POST-PLAN (manual, plan exists, phases remain):
    //     Make detailed plan, implement, enable auto, or talk to agent.
    //

    async function showDevloopPopup(ctx: { cwd: string; hasUI: boolean; ui: any }): Promise<void> {
        if (!activeSlug || !ctx.hasUI) return;

        const slug = activeSlug;
        const planExists = planFileExists(ctx.cwd, slug);
        const { workflowStep } = getWorkflowStatus(ctx.cwd);

        let options: string[];
        let title: string;

        if (workflowStep === "complete") {
            // All phases done — show minimal popup
            title = `DevLoop: ${slug} — Implementation complete\n\nAll phases are done. The session is still bound to this devloop.`;
            options = [
                "💬 Talk to the agent",
            ];
        } else if (autoMode) {
            title = `DevLoop: ${slug} ⚙ Auto Mode\n\nAuto mode is driving the loop. Switch to manual to pick actions yourself.`;
            options = [
                "🖐 Switch to manual",
            ];
        } else if (!planExists) {
            title = `DevLoop: ${slug}\n\nFlow: propose plan → accept → make detailed plan → implement → repeat`;
            options = [
                "💬 Talk to the agent",
                "✅ Accept plan",
                "✅ Accept plan & Auto mode",
            ];
        } else {
            title = `DevLoop: ${slug}\n\nFlow: make detailed plan → implement → repeat`;
            options = [
                "💬 Talk to the agent",
                "📄 Make detailed plan",
                "🔨 Implement (new session)",
                "⚡ Auto mode",
            ];
        }

        const choice = await ctx.ui.select(title, options);

        if (!choice || choice.startsWith("💬 Talk to the agent")) {
            return;
        }

        // ── Emit events for all actions ──

        if (choice.startsWith("✅ Accept plan & Auto mode")) {
            pi.events.emit("devloop:accept-and-auto");
            return;
        }

        if (choice.startsWith("✅ Accept plan")) {
            pi.events.emit("devloop:accept-plan");
            return;
        }

        if (choice.startsWith("📄 Make detailed plan")) {
            pi.events.emit("devloop:plan-detailed");
            return;
        }

        if (choice.startsWith("🔨 Implement")) {
            pi.events.emit("devloop:implement", { slug });
            return;
        }

        if (choice.startsWith("⚡ Auto mode")) {
            pi.events.emit("devloop:auto");
            return;
        }

        if (choice.startsWith("🖐 Switch to manual")) {
            pi.events.emit("devloop:manual");
            return;
        }
    }

    // ─── Hook: agent_end ──────────────────────────────────────────────────

    pi.on("agent_end", async (event, ctx) => {
        refreshWidget(ctx);

        if (!activeSlug) return;

        const { workflowStep } = getWorkflowStatus(ctx.cwd);

        // All phases complete — mark done and show completion popup
        if (workflowStep === "complete") {
            markComplete(ctx);
            await showDevloopPopup(ctx);
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
                driveAutoLoop(ctx);
                return;
            }
            // Turn was aborted (user hit ESC) — show popup so they can
            // decide whether to keep driving or switch to manual.
            await showDevloopPopup(ctx);
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
