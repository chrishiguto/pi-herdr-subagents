# pi-herdr-subagents

subagents for [pi](https://github.com/earendil-works/pi), each in a real [herdr](https://herdr.dev) pane. launch work, keep moving, and receive the result when the child finishes — no polling, screen scraping, or shell-readiness guesses.

## why this exists

[pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) introduced the workflow: visible child panes, an unblocked parent, and asynchronous results. this package implements that workflow directly on herdr.

i wrote it instead of using an existing implementation because i did not want subagents hardcoded in markdown files. here, a subagent is a runtime task with an optional user-owned definition, which gives the workflow more flexibility and a different mental model.

the boundary is small: pi owns the conversation, this extension owns orchestration, and herdr owns panes and process lifecycle. herdr creates panes, waits for their shells, tracks agent identity, and reports process events, so the extension never types terminal commands or infers state from screen contents.

the package supports only pi children in herdr. for tmux, cmux, zellij, wezterm, or other child processes, use pi-interactive-subagents.

## install

requires node 22+, pi 0.84+, and herdr `>=0.8.2 <0.9` (protocol 20). pi must run inside a herdr pane.

add the package to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": ["git:github.com/chrishiguto/pi-herdr-subagents"]
}
```

or use a local checkout:

```jsonc
{
  "packages": ["/path/to/pi-herdr-subagents"]
}
```

then start pi from herdr:

```sh
herdr
# inside a pane
pi
```

the package includes herdr's pi lifecycle reporter. remove or disable a separate `~/.pi/agent/extensions/herdr-agent-state.ts`; two reporters would compete for the same pane state.

## use

| tool | job |
|---|---|
| `subagent` | launch a child in its own pane and return immediately |
| `subagent_resume` | continue a child session in a new pane |
| `subagent_interrupt` | send escape to the child's active turn |
| `subagents_list` | reconcile and list children, state, and elapsed time |

pi also gets `/subagent <agent> [task]` for named agent definitions and `/iterate [task]` for focused work forked from the current session.

no agent definition is required:

```text
use subagent with name "tests" and task "add regression tests for the parser"
```

a skill or prompt template can start the child's workflow:

```json
{"name":"implement auth","task":"implement issue 42","workflow":{"kind":"skill","name":"implement"}}
```

`contextMode` selects inherited conversation state: `lineage-only` keeps ancestry without copying turns, `standalone` starts clean, and `fork` copies the parent's active branch. a child may also set its working directory, model, thinking level, tools, skills, environment, and nested-delegation policy.

agent definitions remain under project `.pi/agents/` or global `~/.pi/agent/agents/`. the package supplies orchestration, not role definitions.

## lifecycle

children report one of two signals:

- `subagent_done` returns the completed result
- `caller_ping` returns a question and resumable session path

if a child exits before either signal, its state remains `unsignaled`; an exit is never treated as success. unfinished launches survive extension reloads and reconcile against their exact herdr agent and pane.

while children run, the pi widget shows `working`, `idle`, or `blocked — needs input`. herdr's sidebar shows process state.

outside herdr, the tools report the missing setup instead of disappearing. set `HERDR_BIN` only when the herdr executable is not on `PATH`.

## limits

- herdr reports agent disappearance, but not the child process exit code; an exit without a child signal remains `unsignaled`
- live children are not classified as stalled; inspect the pane or agent state
- placement splits panes while dimensions remain usable, then moves children to a background tab in the current workspace

[pi-herdr](https://github.com/ogulcancelik/pi-extensions) handles a different use case and can run alongside this package. do not load `pi-interactive-subagents` at the same time: both register the same tool names, and pi keeps the first.

## development

```sh
npm run typecheck
npm test
npm run test:integration:no-model
PI_RUN_HERDR_INTEGRATION=1 npm run test:integration
```

the integration harness uses isolated tmux and herdr sessions and will not touch the default herdr socket.

## lineage

this project descends from [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) by [HazAT](https://github.com/HazAT). its visible-pane model, agent definitions, steer formats, and parts of the child handshake shaped this package.

MIT. `src/herdr/agent-state.ts` is an attributed internal port of herdr's generated pi integration (`HERDR_INTEGRATION_VERSION=8`). parts of agent parsing, steer formatting, and `subagent-done.ts` derive from pi-interactive-subagents (MIT, HazAT). the herdr cli envelope pattern derives from [pi-herdr](https://github.com/ogulcancelik/pi-extensions) (MIT).
