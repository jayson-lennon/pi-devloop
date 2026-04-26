/**
 * DevLoop — pure helper utilities
 *
 * File and prompt helpers with zero Pi dependency.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Slugify a string: lowercase, non-alphanumeric → dash, collapse doubles */
export function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/** Resolve path to a prompt file bundled with this extension */
export function promptPath(name: string): string {
    const extDir = dirname(new URL(import.meta.url).pathname);
    return join(extDir, "..", "prompts", name);
}

/** Read plan.md template, replace $1, and append the user's task after ## TASK */
export function assemblePlanPrompt(slug: string, task: string): string {
    let template = readFileSync(promptPath("plan.md"), "utf-8");
    template = template.replace(/\$1/g, slug);
    template = template.replace(/^---[\s\S]*?---\n*/, "");
    return template + "\n" + task;
}

/** Read plan-detailed.md template and replace $1 */
export function assemblePlanDetailedPrompt(slug: string): string {
    const template = readFileSync(promptPath("plan-detailed.md"), "utf-8");
    const body = template.replace(/^---[\s\S]*?---\n*/, "");
    return body.replace(/\$1/g, slug);
}

/** Read implement.md template and replace $1 */
export function assembleImplementPrompt(slug: string): string {
    const template = readFileSync(promptPath("implement.md"), "utf-8");
    const body = template.replace(/^---[\s\S]*?---\n*/, "");
    return body.replace(/\$1/g, slug);
}

/** Check if the high-level plan file exists on disk */
export function planFileExists(cwd: string, slug: string): boolean {
    return existsSync(resolve(cwd, ".plans", slug, "high-level.md"));
}

/** Read the high-level plan file contents */
export function readHighLevelPlan(cwd: string, slug: string): string | null {
    const path = resolve(cwd, ".plans", slug, "high-level.md");
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

/** Discover all devloop plan slugs on disk, sorted most recent first */
export function discoverPlanSlugs(cwd: string): { slug: string; mtime: number }[] {
    const plansDir = resolve(cwd, ".plans");
    if (!existsSync(plansDir)) return [];

    const results: { slug: string; mtime: number }[] = [];
    for (const entry of readdirSync(plansDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const planFile = resolve(plansDir, entry.name, "high-level.md");
        if (!existsSync(planFile)) continue;
        const stat = statSync(planFile);
        results.push({ slug: entry.name, mtime: stat.mtimeMs });
    }

    results.sort((a, b) => b.mtime - a.mtime);
    return results;
}
