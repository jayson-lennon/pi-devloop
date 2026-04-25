---
description: Create a detailed step-by-step plan for a specific phase
argument-hint: "<plan-dir>"
---

## Instructions

1. Read the high-level plan at `.plans/$1/high-level.md` to determine which phase is next.
2. Create a detailed implementation plan for the next phase. Include an "Acceptance Criteria" section.
3. Save the plan to `.plans/$1/phase-N-detailed.md`
4. Review the saved plan for major issues that might result in failure to implement the feature. Also comment on potentially insecure or performance implications. Divergence from the plan is _not_ something to comment on.
5. Report potential problems to the user.

Do NOT implement anything — only plan. WAIT FOR USER APPROVAL with the message "Waiting for your approval. When everything looks good, select 'Implement'.".
