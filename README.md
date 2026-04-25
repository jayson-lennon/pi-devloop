# DevLoop

Phased task implementation workflow extension for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

DevLoop is an attempt to address the fact that we can't perfectly plan a task. One small deviation can cascade into additional rogue changes that introduce unforeseen problems.

With this in mind, DevLoop tries to address the problem of cascading deviations by providing a structured workflow:

1. Generate a high-level multi-phased implementation plan documenting _roughly_ what to do
2. Generate a detailed plan for the next implementation phase
3. Implement the detailed plan
4. Review the implementation and update the high-level (rough) plan based on the deviations (if any)
5. GOTO (2)

Since we generate the detailed plan at the start of each implementation phase, it always has the most up-to-date information for planning. This (theoretically) increases the success rate of the detailed plan versus making one large plan up-front.

## Usage

1. `/devloop new "name of this task"`
2. Describe what to do for the task
3. Iterate on plan with agent
4. (Popup) Accept plan
5. (Popup) Generate detailed plan
6. (Popup) Implement
7. You are in the loop. Now it's just 4, 5, 6 until feature is complete.

### Resuming

DevLoop uses the `.plans` directory to store plans and calculates the current state from the plans themselves. You can resume any DevLoop session using the standard `/resume` command Pi offers, and then pressing `Ctrl+Q` to activate the popup.

If `Ctrl+Q` doesn't work for some reason, then type `/devloop resume "name of the plan"`

### Full auto?

Not yet. Sometimes there is an unforeseen critical issue when generating the detailed plan. LLMs are bad at deciding what "critical" is and what the best course of action is for your project.

If you have any ideas on how to reliably get the agent to make decent decisions, feel free to open an issue and discuss.

## Installation

```bash
pi install https://github.com/jayson-lennon/pi-devloop
```

Or clone this repo and reference it in your Pi extension config.

## Commands

| Command                  | Description                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/devloop new <task>`    | Start a new DevLoop workflow. Instructions will be displayed on screen.                                                                         |
| `/devloop resume <slug>` | Re-attach DevLoop to an existing plan (directory under `.plans/`). Use this if you resume a session and `Ctrl+Q` doesn't work or after exiting. |
| `/devloop exit`          | Exit the current DevLoop. If you want to stop using DevLoop mid-session, use this command.                                                      |
| `Ctrl+Q`                 | Show the DevLoop popup (when active).                                                                                                           |

## Notes

I kept the definitions of "plan" and "detailed plan" fairly lean in order to allow the models to do their thing (I only tested with `glm-5.1`). Using this on programming projects is implied, but not directly specified in the prompts. So DevLoop does work on non-programming tasks as well (like writing this README).

## License

[LGPL-3.0-or-later](https://www.gnu.org/licenses/lgpl-3.0.en.html)
