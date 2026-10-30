# ClickUp task integration

## Contract

ClickUp is an optional built-in integration, registered beside Linear. It uses
the personal API token of a dedicated AI user. No OAuth app, App Center listing,
public ingress, or webhook is required. The token owner is the assignee that
activates the integration. One configured Workspace bounds its access; optional
List IDs narrow intake further.

| Linear behavior                      | ClickUp behavior                                                     |
| ------------------------------------ | -------------------------------------------------------------------- |
| Agent assignment                     | Poll tasks assigned to the token owner                               |
| Agent session greeting               | Task comment with session link and commands                          |
| Plan, implement, or free-form prompt | New task comments after the greeting                                 |
| Planning interview and plan          | Questions and implementation plan in comments                        |
| Ready / In Progress transitions      | Configurable status names, matched against the task's List           |
| Stop                                 | `stop` comment, removal of assignment, or closing the task           |
| Implementation completion            | Push branch, create PR, post link                                    |
| Session viewer and continuation      | Native Open Session record with a ClickUp external reference         |
| Issue tools                          | Task-scoped read/comment/create-follow-up tools using the same token |

The default repository supplies the codebase. Every task gets an isolated
worktree, including when the default repo is a shared checkout. Task IDs, not
mutable titles, determine session and branch identities. Reassignment resumes
the same worktree. Nothing deletes work when a task is closed or unassigned.

## Intake and persistence

Poll every 30 seconds. Paginate assigned tasks and comments completely; process
comments oldest first. Ignore the AI user's own comments. The first discovery
records a baseline, so old discussion is context and never executes as commands.
Only currently assigned, open tasks in scope can start work. A full assignment
scan must succeed before absence can suspend a session.

Persist state atomically under the instance state directory. Claim each comment
before dispatch, permit one running turn per task, and leave later comments
queued in ClickUp. A stop command can interrupt a running turn. After a restart,
an interrupted turn is reported and awaits a new instruction rather than being
executed twice. Replies use a durable outbox and a stable marker to reconcile a
successful POST whose response was lost. Ambiguous writes are never blindly
retried within the HTTP client.

## Credentials and run authority

Settings uses the existing secret form and enable switch. Responses report
credential presence only. Tokens never enter prompts, session metadata, logs,
or child-process environments. API requests use ClickUp's fixed HTTPS origin,
timeouts, pacing, and rate-limit backoff. Non-success responses expose status
codes without echoing the response body.

ClickUp-driven turns are unattended. They receive no unrelated external MCP
servers, personal identity grants, or administrative tools. Their built-in
ClickUp tools can read and comment on the assigned task and create follow-up
tasks in its List. Follow-ups default to unassigned to avoid recursive intake.
Planning runs have read-only task tools. Status writes and lifecycle replies
remain server-controlled. Task text cannot select the token, workspace, repo,
run policy, or tool scope.

## Verification

Use a local HTTP fixture for the documented ClickUp API and a deterministic
runner for lifecycle tests. Cover pagination, assignment filtering, old/self
comments, duplicate delivery, restart, stop, errors, outbox reconciliation,
status transitions, and follow-up creation. Verify real Settings at desktop and
phone widths. Live ClickUp acceptance requires the new AI user's token, a
configured repository/model account, and a disposable task assigned to that user.

## API sources

- [Personal tokens](https://developer.clickup.com/docs/authentication)
- [Assigned task query](https://developer.clickup.com/reference/getfilteredteamtasks)
- [Comments and pagination](https://developer.clickup.com/reference/gettaskcomments)
- [Create comments](https://developer.clickup.com/reference/createtaskcomment)
- [Create tasks](https://developer.clickup.com/reference/createtask)
- [Rate limits](https://developer.clickup.com/docs/rate-limits)
