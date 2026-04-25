---
description: Implement a phase from its detailed plan and produce a review
argument-hint: "<plan-dir>"
---

Implement the current phase.

The high-level plan is provided in context above. Review it to determine which phase is next for implementation.
Read the detailed plan at `.plans/$1/phase-N-detailed.md` (find the relevant one).

If no detailed plan is found. Report to the user "No detailed plan found for phase N" and immediately STOP. Do not attempt to implement anything.

## Instructions

1. Follow the detailed plan. Adapt as needed if you encounter unforeseen issues.
2. After implementation, review the changes.
3. Update the high-level plan with any required changes to future phases based on the divergence summary. Use markdown strikethrough when editing or removing items from the high-level plan and leave a brief note at the end of the impacted phase section.

Here is the format for the review (ALWAYS INCLUDE ALL SECTIONS):

---

## Review: Phase N — <phase name>

### Changes

A brief description of what changed and why.

### Divergence Summary

List things that did NOT go according to plan — changes, additions, omissions, or reordering. This includes changes to the high-level plan.
If everything was implemented as planned, just say "None."

### Verification

What you did to verify the changes work (build, tests, manual checks, etc.).

### Risks

Any concerns, things that might break, or follow-up work needed.

### Next Steps

Plan phase <N>.

---

Example review:

## Review: Phase 1 — Dependency Upgrade

### Changes

- Bumped eframe/egui 0.31 → 0.34, added egui_taffy, taffy, log
- Updated `update()` → `ui()` to match eframe 0.34 trait change, changed `ctx` refs to `ui.ctx()`, simplified `on_exit()` signature
- Added `source_size` field to ColorImage construction (new required field in 0.34)

### Divergence Summary

- `on_exit()` signature change was not in the plan — eframe 0.34 removed the glow context parameter
- Added `log` workspace dependency — plan didn't mention it but egui_taffy requires it

### Verification

- `just check` — zero errors
- `cargo check --workspace --tests` — zero errors
- Deprecation warnings for TopBottomPanel, SidePanel are expected (Phase 2 replaces these)

### Risks

- Deprecation warnings mean these APIs may be removed in a future egui version
- Phase 2 must account for the extra API changes found here

### Next Steps

This was the last phase. Implementation complete.
