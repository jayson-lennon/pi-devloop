/**
 * DevLoop — session handoff for implementation
 *
 * This is the most dangerous function in the extension. It calls
 * ctx.newSession() which replaces the current session.
 *
 * THINGS THAT HAVE BEEN TRIED AND FAILED:
 *
 *   ❌ pi.sendUserMessage(fullPrompt) after ctx.newSession()
 *      → stale pi, throws. Message never appears in new session.
 *
 *   ❌ pi.setSessionName(slug) inside withSession callback
 *      → stale pi, throws. This was the bug that caused pi to exit
 *      completely during auto-implement.
 *
 *   ❌ ctx.ui.setEditorText(fullPrompt) after ctx.newSession()
 *      → stale ctx, throws.
 *
 *   ❌ Not using withSession at all → new session is empty.
 *
 * WHAT WORKS: The withSession pattern (see handoff.ts example in Pi).
 *
 *   await ctx.newSession({
 *       setup: async (sm) => { sm.appendCustomEntry(...) },
 *       withSession: async (newCtx) => {
 *           await newCtx.sendUserMessage(fullPrompt);  // ✅
 *           // pi.setSessionName(slug);                 // ❌ STILL STALE
 *       },
 *   });
 *
 * Trade-off: We can't set the session name because pi.setSessionName
 * is on the stale pi object and ReplacedSessionContext doesn't have it.
 * Prompt delivery > cosmetic session name.
 */

import { ENTRY_TYPE } from "./constants.js";
import { assembleImplementPrompt, readHighLevelPlan } from "./helpers.js";

/** Context shape needed by handleDoImplement */
interface ImplementContext {
    cwd: string;
    hasUI: boolean;
    ui: any;
    sessionManager: {
        getSessionFile(): string;
        getBranch(): any[];
    };
    newSession(options: any): Promise<{ cancelled: boolean }>;
}

export async function handleDoImplement(
    slug: string,
    autoMode: boolean,
    ctx: ImplementContext,
): Promise<void> {
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

    // autoMode is passed through to the custom entry so the replacement session
    // restores the correct mode.
    const result = await ctx.newSession({
        parentSession: currentSessionFile,
        setup: async (sm: any) => {
            sm.appendCustomEntry(ENTRY_TYPE, { slug, active: true, autoMode });
        },
        withSession: async (newCtx: any) => {
            // withSession runs after session replacement: old pi/ctx are stale.
            // Use only newCtx for session-bound work.
            //
            // NOTE: pi.setSessionName(slug) would throw here — pi is stale.
            // Session name is less important than getting the prompt delivered.

            await newCtx.sendUserMessage(fullPrompt);
        },
    });

    if (result.cancelled) {
        ctx.ui.notify("Handoff cancelled.", "info");
        return;
    }
}
