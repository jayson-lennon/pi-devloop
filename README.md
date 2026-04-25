# DevLoop

Phased task implementation workflow extension for [Pi](https://github.com/mariozechner/pi).

DevLoop is an attempt to address the fact that we can't perfectly plan a task. One small deviation can cascade into additional rogue changes that introduce unforeseen problems.

With this in mind, DevLoop provides a thin wrapper around a workflow that tries to address this:

1. Generate a high-level multi-phased implementation plan documenting _roughly_ what to do
2. Generate a detailed plan for the next implementation phase
3. Implement the detailed plan
4. Review the implementation and update the high-level (rough) based on deviations
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

I couldn't get the combination of message sending + command handling + session management working the way I wanted to. So for "Implement" you'll need to hit enter a couple times after selecting it from the popup.

### Full auto?

Not yet. Sometimes there is a critical issue when generating the detailed plan. LLMs are bad at deciding what "critical" is and what the best course of action is for your project.

If you have any ideas on how to reliably get the agent to make decent decisions feel free to open an issue and discuss.

## Installation

```bash
pi install https://github.com/jayson-lennon/pi-devloop
```

Or clone this repo and reference it in your Pi extension config.

## Commands

| Command                  | Description                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/devloop new <task>`    | Start a new DevLoop workflow. Instructions will be displayed on screen.                                                                       |
| `/devloop resume <slug>` | Re-attach DevLoop to an existing plan (directory under `.plans/`). Use this if you resume a session and Ctrl+Q doesn't work or after exiting. |
| `/devloop exit`          | Exit the current DevLoop. If you want to stop using DevLoop mid-session, use this command.                                                    |
| `Ctrl+Q`                 | Show the DevLoop popup (when active).                                                                                                         |

## License

[LGPL-3.0-or-later](https://www.gnu.org/licenses/lgpl-3.0.en.html)
