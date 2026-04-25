/**
 * DevLoop — popup UI
 *
 * Shows context-aware popup options after every agent turn.
 * Receives state as parameters — no closure coupling to the extension.
 *
 * Four popup states:
 *   COMPLETE — all phases done, only "talk to agent"
 *   AUTO — auto mode running, only "switch to manual"
 *   PRE-PLAN — manual, no plan file yet, accept options
 *   POST-PLAN — manual, plan exists, implement options
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { planFileExists } from "./helpers.js";
import { getWorkflowStatus } from "./phases.js";

/** Minimal context needed by the popup */
interface PopupContext {
    cwd: string;
    hasUI: boolean;
    ui: any;
}

export async function showDevloopPopup(
    pi: ExtensionAPI,
    ctx: PopupContext,
    activeSlug: string,
    autoMode: boolean,
): Promise<void> {
    if (!activeSlug || !ctx.hasUI) return;

    const slug = activeSlug;
    const planExists = planFileExists(ctx.cwd, slug);
    const { workflowStep } = getWorkflowStatus(ctx.cwd, slug);

    let options: string[];
    let title: string;

    if (workflowStep === "complete") {
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
