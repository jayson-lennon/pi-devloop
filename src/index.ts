/**
 * DevLoop — Phased workflow extension for Pi
 *
 * Drives a plan → plan-detailed → implement loop with automatic
 * session handoffs for implementation phases.
 *
 * Commands:
 *   /devloop new <task>        — Start a new devloop workflow
 *   /devloop resume [task]     — Resume an existing devloop task
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
 *      handleDoImplement(slug, autoMode, cachedCmdCtx) — using the cached
 *      command context which HAS newSession().
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
 * custom entry. However, the auto-loop's implement step requires cachedCmdCtx
 * which is only available after running a /devloop command. Use
 * /devloop resume <task> to re-enter the loop and hydrate cachedCmdCtx.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ENTRY_TYPE, WIDGET_ID } from "./constants.js";
import { assemblePlanDetailedPrompt, assemblePlanPrompt, discoverPlanSlugs, planFileExists, slugify } from "./helpers.js";
import { deriveNextStep, getWorkflowStatus, isContextOverLimit, renderProgressLines } from "./phases.js";
import { handleDoImplement } from "./implement.js";
import { showDevloopPopup } from "./popup.js";

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

    function refreshWidget(ctx: { cwd: string; hasUI: boolean; ui: any }): void {
        if (!activeSlug || !ctx.hasUI) return;

        const { phases, workflowStep } = getWorkflowStatus(ctx.cwd, activeSlug);
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
    function markComplete(ctx: { cwd: string; hasUI: boolean; ui: any }): void {
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
    // handleDoImplement(slug, autoMode, cachedCmdCtx) which HAS the right context type.
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
        if (!activeSlug || activeSlug !== slug) return;
        if (!cachedCmdCtx) {
            pi.sendMessage({
                customType: "devloop",
                content: `⚠ Cannot auto-implement — run \`/devloop resume ${slug}\` to re-enter the loop.`,
                display: true,
            }, { triggerTurn: false });
            return;
        }
        await handleDoImplement(slug, autoMode, cachedCmdCtx);
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
            if (!prefix) {
                return [
                    { value: "new ", label: "new <task> — Start a new devloop workflow" },
                    { value: "resume ", label: "resume [task] — Resume an existing devloop" },
                ];
            }
            const subcommands = [
                { value: "new ", label: "new <task> — Start a new devloop workflow" },
                { value: "resume ", label: "resume [task] — Resume an existing devloop" },
            ];
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
            } else if (sub === "resume") {
                await handleResume(rest, ctx);
            } else {
                ctx.ui.notify("Usage: /devloop new <task> | /devloop resume [task]", "warning");
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

    async function handleResume(
        args: string,
        ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
    ): Promise<void> {
        const task = args.trim();
        let targetSlug: string | undefined;

        if (task) {
            // /devloop resume <task>
            targetSlug = slugify(task);
            if (!targetSlug) {
                ctx.ui.notify("Could not generate a slug from the task name.", "error");
                return;
            }
            if (!planFileExists(ctx.cwd, targetSlug)) {
                ctx.ui.notify(
                    `No plan found for "${targetSlug}" in .plans/${targetSlug}/. Run /devloop new to create one.`,
                    "error",
                );
                return;
            }
        } else {
            // /devloop resume — show picker
            const slugs = discoverPlanSlugs(ctx.cwd);
            if (slugs.length === 0) {
                ctx.ui.notify("No devloop tasks found in .plans/.", "info");
                return;
            }
            if (slugs.length === 1) {
                targetSlug = slugs[0]!.slug;
            } else {
                const options = slugs.map(s => s.slug);
                const choice = await ctx.ui.select("Select a devloop task to resume:", options);
                if (!choice) return;
                targetSlug = choice;
            }
        }

        if (!targetSlug) return; // picker cancelled

        // Reject if this session is already bound to a DIFFERENT devloop.
        // Allow if bound to the SAME slug (re-hydration of cachedCmdCtx).
        if (activeSlug && activeSlug !== targetSlug) {
            ctx.ui.notify(
                `This session is already bound to devloop "${activeSlug}". Start a new Pi session for a different devloop.`,
                "warning",
            );
            return;
        }

        await doResume(ctx, targetSlug);
    }

    async function doResume(
        ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1],
        slug: string,
    ): Promise<void> {
        const alreadyBound = activeSlug === slug; // re-hydration vs fresh bind

        // 1. Bind slug
        activeSlug = slug;

        // 2. THE ENTIRE POINT: hydrate cachedCmdCtx
        cachedCmdCtx = ctx;

        // 3. Persist state and set session name only for fresh binds
        if (!alreadyBound) {
            persistState();
            pi.setSessionName(slug);
        }

        // 4. Refresh widget
        refreshWidget(ctx);

        // 5. Notify and drive loop
        const { workflowStep } = getWorkflowStatus(ctx.cwd, slug);
        if (alreadyBound) {
            ctx.ui.notify(`Re-entered devloop "${slug}".`, "info");
        } else if (workflowStep === "complete") {
            ctx.ui.notify(`Resumed devloop "${slug}" — all phases complete.`, "info");
        } else if (autoMode) {
            ctx.ui.notify(`Resumed devloop "${slug}" in auto mode.`, "info");
        } else {
            ctx.ui.notify(`Resumed devloop "${slug}" in manual mode.`, "info");
        }

        // 6. If auto mode, drive the loop immediately
        if (autoMode && workflowStep !== "complete") {
            driveAutoLoop(ctx);
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

    // ─── Hook: agent_end ──────────────────────────────────────────────────

    pi.on("agent_end", async (event, ctx) => {
        refreshWidget(ctx);

        if (!activeSlug) return;

        const { workflowStep } = getWorkflowStatus(ctx.cwd, activeSlug);

        // All phases complete — mark done and show completion popup
        if (workflowStep === "complete") {
            markComplete(ctx);
            showDevloopPopup(pi, ctx, activeSlug, autoMode);
            return;
        }

        // Auto mode: drive the loop (unless turn was aborted or cachedCmdCtx missing)
        if (autoMode) {
            if (!cachedCmdCtx) {
                // Auto-loop stuck — cachedCmdCtx not hydrated.
                // Notify user and fall through to popup.
                ctx.ui.notify(
                    `Auto-loop paused — run \`/devloop resume ${activeSlug}\` to continue.`,
                    "warning",
                );
                showDevloopPopup(pi, ctx, activeSlug, autoMode);
                return;
            }

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
            showDevloopPopup(pi, ctx, activeSlug, autoMode);
            return;
        }

        // Manual mode: show popup (fire-and-forget so agent_end resolves
        // and Pi stops the spinner)
        showDevloopPopup(pi, ctx, activeSlug, autoMode);
    });

    // ─── Shortcut: Ctrl+Q ────────────────────────────────────────────────────

    pi.registerShortcut(Key.ctrl("q"), {
        description: "Show devloop popup",
        handler: async (ctx) => {
            refreshWidget(ctx);
            await showDevloopPopup(pi, ctx, activeSlug, autoMode);
        },
    });
}
