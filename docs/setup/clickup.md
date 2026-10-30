# ClickUp

The ClickUp integration turns tasks assigned to a dedicated AI user into Open
Session coding sessions. It uses that user's personal API token. Polling works
on a local computer without OAuth, a published app, or public ingress.

## Setup

1. Create the AI user in ClickUp and grant it access to the Lists it should use.
2. Sign in as that user and generate a personal API token in Settings → Apps.
3. In Open Session, configure a default repository and a model account. Git push
   and `gh` must work from the host for automatic pull requests.
4. Open Settings → Integrations → ClickUp. Enter the token and Workspace ID,
   enable the integration, save, and restart Open Session.
5. Assign a disposable task to the AI user. Its greeting should appear after the
   next poll. Follow the session link or reply `plan`, `implement`, or an instruction.

| Environment variable     | Required | Meaning                                                              |
| ------------------------ | -------- | -------------------------------------------------------------------- |
| `CLICKUP_API_TOKEN`      | Yes      | Dedicated AI user's personal token                                   |
| `CLICKUP_WORKSPACE_ID`   | Yes      | Numeric Workspace ID from its ClickUp URL                            |
| `CLICKUP_LIST_IDS`       | No       | Comma-separated List IDs to restrict intake                          |
| `CLICKUP_POLL_SECONDS`   | No       | 10–3600 seconds, default 30                                          |
| `CLICKUP_READY_STATUS`   | No       | Plan-ready status, default `ready`                                   |
| `CLICKUP_WORKING_STATUS` | No       | Implementation status, default `in progress`                         |
| `ENABLE_CLICKUP_AGENT`   | No       | Literal `true` enables; otherwise use `integrations.clickup.enabled` |

## Task workflow

The first assignment creates an isolated worktree in the default repository and
posts a greeting. Existing discussion is context, not executable instructions.
Subsequent comments from people other than the AI user steer the session.

- `plan` explores the repository in ask mode and asks questions through comments.
  The finished plan is posted under `# Implementation Plan`.
- `implement` starts coding from the saved plan or task description. `yes`, `go`,
  and `proceed` also start a plan awaiting implementation. Moving such a task to
  the configured working status has the same effect.
- Other comments continue the conversation. During a planning interview they
  remain read-only. After a completed plan, use `implement` to begin coding.
- `stop` or `cancel` interrupts the current turn and clears older queued
  instructions. Removing the AI user's assignment or closing the task suspends it.
- Reassignment keeps the worktree and session but waits for a fresh instruction.

Status names match case-insensitively within the task's List. A missing status
produces a comment and leaves the status unchanged. Completed work is committed
and pushed by the coding agent; Open Session opens a PR and posts its URL.
Review and merging remain separate.

The coding session can read the task, add a separate comment, and create
follow-up tasks or subtasks in the same List. New tasks default to unassigned.
Planning sessions receive only the read tool. The token stays in the server;
unrelated connectors and administrative tools are not exposed to ClickUp turns.

## Local testing and recovery

The repository's `.agents/start.sh` is a demo preview and disables integrations.
Run `bun run start:local` for a regular instance on port 3851 with state under
the gitignored `.local-state/` directory. `PORT` and `OPENSESSION_LOCAL_STATE`
override those defaults. The launcher starts its own session kernel and supports
the Settings restart button. Configure the repository, provider, and token in
that instance. Settings stores the token in `.local-state/opensession.env` with
mode 0600. Do not put a token in a tracked file or a shell command.

State is stored under the instance state directory in `clickup.json` (or
`.opensession-clickup.json` when an explicit state root is used). Keep it when
restarting. Instructions claimed before a crash are not replayed. Open Session
reports the interruption and waits for another comment. Pending replies are
reconciled against their visible `[Open Session …]` marker before retrying.

Changing the token to another user or switching Workspace requires a separate
state directory. API failures appear in agent health. Rate limits delay requests;
an incomplete assignment scan never implies that tasks were unassigned.

## API references

[Authentication](https://developer.clickup.com/docs/authentication),
[assigned tasks](https://developer.clickup.com/reference/getfilteredteamtasks),
[comment pagination](https://developer.clickup.com/reference/gettaskcomments),
[task creation](https://developer.clickup.com/reference/createtask), and
[rate limits](https://developer.clickup.com/docs/rate-limits).
