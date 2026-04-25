---
description: Create a high-level phased implementation plan
argument-hint: "<task description>"
---

Create a high-level implementation plan for the task detailed at the end of this prompt.

DO NOT IMPLEMENT THE PLAN.

## Instructions

1. Explore the problem space to understand the request
2. Break the work into numbered phases. Don't assign phases to trivial changes - merge them together until the phase is significant.
3. Ask clarifying questions to address ambiguities in the request
4. Once the user answers all the questions, propose the plan to the user as a chat response. DO NOT SAVE TO DISK.
5. After the user accepts the plan, write it to `.plans/$1/high-level.md`
6. Report to the user "High-level plan created. Generate a detailed plan next"

## Notes

- All plans must use implementation phases (even 1 phase plans)
- Use markdown checkboxes for implementation phases so that we can check them off as we go.
- The plan must have an "Acceptance Criteria" section that shows the high-level goals.
- The plan must have a "Problem" section at the beginning so the user and agent both understand what's being solved.

### Checkbox example

- [ ] Phase 1: Foo the bar
- subtask 1
- subtask 2
  ...

## TASK
