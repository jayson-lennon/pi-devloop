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

1. Run `/devloop new "task name"` — this creates a plan directory under `.plans/` and binds the session to the workflow.
2. Describe what you want done in the chat — the agent generates a high-level plan.
3. Press `Ctrl+Q` to open the popup — choose **Accept plan** (or **Accept plan & Auto mode**).
4. Press `Ctrl+Q` again — choose **Make detailed plan** to flesh out the next phase.
5. Press `Ctrl+Q` again — choose **Implement (new session)** to spin up an implementation session.
6. Repeat steps 4–5 until all phases are complete.

### Resuming

DevLoop stores all state in the `.plans/` directory and in the session itself. Use Pi's built-in `/resume` to return to a DevLoop session — the slug, phase progress, and mode (auto/manual) are restored automatically. Press `Ctrl+Q` to pick up where you left off.

### Auto mode

**Auto mode** is available from the popup — choose **Accept plan & Auto mode** or **Auto mode** at any point to let DevLoop drive the loop. It will automatically plan detailed phases, implement them, and repeat until all phases are done.

Auto mode stops if the agent turn is aborted (you press Escape) or if context utilization exceeds 70%, at which point you should compact the session or switch to manual mode via the popup.

Manual mode is the default — you pick each action via the popup after every agent turn.

> **Note:** A session is permanently bound to its DevLoop. There is no "exit" or "pause" — once you start a DevLoop, that session is always a DevLoop session.

## Installation

```bash
pi install https://github.com/jayson-lennon/pi-devloop
```

Or clone this repo and reference it in your Pi extension config.

### Get latest version

```bash
pi update https://github.com/jayson-lennon/pi-devloop
```

## Commands

| Command               | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `/devloop new <task>` | Start a new DevLoop workflow. Instructions will be displayed.    |
| `Ctrl+Q`              | Show the DevLoop popup with context-aware options (when active). |

### Popup actions (via `Ctrl+Q`)

The popup shows different options depending on the current state:

| State        | Available actions                                                       |
| ------------ | ----------------------------------------------------------------------- |
| Pre-plan     | Talk to agent, Accept plan, Accept plan & Auto mode                    |
| Post-plan    | Talk to agent, Make detailed plan, Implement (new session), Auto mode  |
| Auto mode    | Switch to manual                                                        |
| Complete     | Talk to agent                                                           |

## Notes

I kept the definitions of "plan" and "detailed plan" fairly lean in order to allow the models to do their thing (I only tested with `glm-5.1`). Using this on programming projects is implied, but not directly specified in the prompts. So DevLoop does work on non-programming tasks as well (like writing this README).

## License

[LGPL-3.0-or-later](https://www.gnu.org/licenses/lgpl-3.0.en.html)
