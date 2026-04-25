/**
 * DevLoop — Phased workflow extension for Pi
 *
 * Drives a plan → plan-detailed → implement loop with automatic
 * session handoffs for implementation phases.
 *
 * Commands:
 *   /devloop-new <task>   — Start a new devloop workflow
 *   /devloop-next          — Show the devloop popup
 *   /devloop-implement     — Hand off to new session and implement
 *   /devloop-exit          — Exit the current devloop
 *
 * The extension shows a popup after every agent turn (when active) with
 * context-aware options based on whether the high-level plan exists on disk.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const ENTRY_TYPE = "devloop-state";

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
    // __dirname is available via jiti for the extension's directory
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
    // Strip YAML frontmatter before sending to the agent
    template = template.replace(/^---[\s\S]*?---\n*/, "");
    // Append task after ## TASK
    return template + "\n" + task;
}

/** Read plan-detailed.md template and replace $1 */
function assemblePlanDetailedPrompt(slug: string): string {
    const template = readFileSync(promptPath("plan-detailed.md"), "utf-8");
    // Strip frontmatter
    const body = template.replace(/^---[\s\S]*?---\n*/, "");
    return body.replace(/\$1/g, slug);
}

/** Read implement.md template and replace $1 */
function assembleImplementPrompt(slug: string): string {
    const template = readFileSync(promptPath("implement.md"), "utf-8");
    // Strip frontmatter
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

// ─── Extension ───────────────────────────────────────────────────────────────

export default function devloopExtension(pi: ExtensionAPI): void {
    let activeSlug: string | undefined;
    let needsPlanPrefix = false; // true after /devloop new, cleared after first input

    // ─── State persistence ─────────────────────────────────────────────────

    function persistState(): void {
        pi.appendEntry(ENTRY_TYPE, {
            slug: activeSlug,
            active: !!activeSlug,
        });
    }

    function clearState(): void {
        activeSlug = undefined;
        needsPlanPrefix = false;
        persistState();
    }

    // ─── Session restore ──────────────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        activeSlug = undefined;

        const entries = ctx.sessionManager.getEntries();
        // Find the latest devloop-state entry
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (
                entry.type === "custom" &&
                (entry as any).customType === ENTRY_TYPE
            ) {
                const data = (entry as any).data;
                if (data?.active && data?.slug) {
                    activeSlug = data.slug;
                }
                break;
            }
        }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    pi.registerCommand("devloop-new", {
        description: "Start a new devloop workflow",
        getArgumentCompletions: (prefix: string) => {
            if (!prefix) return [{ value: " ", label: "<task description>" }];
            return null;
        },
        handler: async (args, ctx) => {
            await handleNew(args.trim(), ctx);
        },
    });

    pi.registerCommand("devloop-next", {
        description: "Show the devloop popup",
        handler: async (_args, ctx) => {
            await showDevloopPopup(ctx);
        },
    });

    pi.registerCommand("devloop-resume", {
        description: "Re-attach devloop to a slug (fixes broken state)",
        getArgumentCompletions: (prefix: string) => {
            try {
                const extDir = dirname(new URL(import.meta.url).pathname);
                // .plans is relative to cwd, but we can't access it here easily
                // Just return a hint
                if (!prefix) return [{ value: " ", label: "<slug> (directory name under .plans/)" }];
            } catch { }
            return null;
        },
        handler: async (args, ctx) => {
            const slug = args.trim();
            if (!slug) {
                ctx.ui.notify("Usage: /devloop-resume <slug>", "warning");
                return;
            }
            if (!planFileExists(ctx.cwd, slug)) {
                ctx.ui.notify(`No plan found at .plans/${slug}/high-level.md`, "error");
                return;
            }
            activeSlug = slug;
            persistState();
            pi.setSessionName(slug);
            ctx.ui.notify(`DevLoop resumed: **${slug}**`, "info");
        },
    });

    pi.registerCommand("devloop-exit", {
        description: "Exit the current devloop",
        handler: async (_args, ctx) => {
            handleExit(ctx);
        },
    });

    pi.registerCommand("devloop-implement", {
        description: "Hand off to a new session and implement the next phase",
        handler: async (_args, ctx) => {
            await handleDoImplement(ctx);
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

        // Check if plan directory already exists
        if (existsSync(resolve(ctx.cwd, ".plans", slug))) {
            ctx.ui.notify(
                `Plan directory .plans/${slug}/ already exists. Start with a different name.`,
                "error",
            );
            return;
        }

        // Activate devloop
        activeSlug = slug;
        persistState();
        pi.setSessionName(slug);

        // Mark that the next user input should be prefixed with the plan prompt
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
        clearState();
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

        // Read the high-level plan
        const highLevelPlan = readHighLevelPlan(ctx.cwd, slug);
        if (!highLevelPlan) {
            ctx.ui.notify(
                `No high-level plan found at .plans/${slug}/high-level.md. Accept the plan first.`,
                "error",
            );
            return;
        }

        // Assemble the implement prompt
        const implementPrompt = assembleImplementPrompt(slug);

        const currentSessionFile = ctx.sessionManager.getSessionFile();

        // Grab the last assistant message for context
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

        // Build the full prompt with plan context baked in
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

        // Create new session with state persisted via setup so session_start can find it
        const result = await ctx.newSession({
            parentSession: currentSessionFile,
            setup: async (sm) => {
                sm.appendCustomEntry(ENTRY_TYPE, { slug, active: true });
            },
        });

        if (result.cancelled) {
            ctx.ui.notify("Handoff cancelled.", "info");
            return;
        }

        pi.setSessionName(slug);

        // Put prompt in editor — user presses Enter to submit
        ctx.ui.setEditorText(fullPrompt);
    }

    // ─── Hook: input ──────────────────────────────────────────────────────

    // On the first message after /devloop new, prepend the plan template
    pi.on("input", async (event, ctx) => {
        if (!needsPlanPrefix || !activeSlug) return { action: "continue" };

        needsPlanPrefix = false;

        const userText = event.text;
        const prefix = assemblePlanPrompt(activeSlug, "");
        const combined = prefix + "\n" + userText;

        return { action: "transform", text: combined };
    });

    // ─── Popup logic (shared between agent_end, command, shortcut) ────────

    async function showDevloopPopup(ctx: { cwd: string; hasUI: boolean; ui: any }): Promise<void> {
        if (!activeSlug || !ctx.hasUI) return;

        const slug = activeSlug;
        const planExists = planFileExists(ctx.cwd, slug);

        // Build context-aware options
        let options: string[];
        let title: string;

        if (planExists) {
            title = `DevLoop: ${slug}\n\nFlow: plan-detailed → implement → repeat\n\nPress Esc to dismiss. Use Ctrl+Q to show this popup again.`;
            options = [
                "💬 Free text",
                "📄 Plan detailed",
                "🔨 Implement (new session)",
                "🚪 Exit devloop",
            ];
        } else {
            title = `DevLoop: ${slug}\n\nFlow: propose plan → accept → plan-detailed → implement → repeat\n\nPress Esc to dismiss. Use Ctrl+Q to show this popup again.`;
            options = [
                "💬 Free text",
                "✅ Accept plan (save to disk)",
                "🚪 Exit devloop",
            ];
        }

        const choice = await ctx.ui.select(title, options);

        if (!choice || choice.startsWith("💬 Free text")) {
            return;
        }

        if (choice.startsWith("✅ Accept plan")) {
            pi.sendUserMessage(
                `The plan looks good. Save it to \`.plans/${slug}/high-level.md\` now.`,
                { deliverAs: "followUp" },
            );
            return;
        }

        if (choice.startsWith("📄 Plan detailed")) {
            pi.sendUserMessage(assemblePlanDetailedPrompt(slug), { deliverAs: "followUp" });
            return;
        }

        if (choice.startsWith("🔨 Implement")) {
            ctx.ui.setEditorText("/devloop-implement");
            return;
        }

        if (choice.startsWith("🚪 Exit devloop")) {
            clearState();
            ctx.ui.notify(`DevLoop "${slug}" exited.`, "info");
            return;
        }
    }

    // ─── Hook: agent_end ──────────────────────────────────────────────────

    pi.on("agent_end", async (_event, ctx) => {
        await showDevloopPopup(ctx);
    });

    // ("devloop-next" command is handled above)

    // ─── Shortcut: Ctrl+D ────────────────────────────────────────────────

    pi.registerShortcut(Key.ctrl("q"), {
        description: "Show devloop popup",
        handler: async (ctx) => {
            await showDevloopPopup(ctx);
        },
    });
}
