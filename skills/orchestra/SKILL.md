---
name: orchestra
description: Multi-model way of working for Claude Code. A Haiku subagent (junior-haiku) asks the opening questions, writes drafts, runs and tests the result, makes small fixes and handles git; Opus (the main session plus the senior-opus subagent) orchestrates, builds, thinks deeply and reviews. Use it when starting any task that builds, codes or debugs something (an app, website, game, script or artifact), and when the user says "orchestra", "use the team", "hand it to the junior" or "use Haiku". Not needed for quick questions or one-line changes.
---

# Orchestra: Haiku as the junior, Opus as the conductor

You (the main session) are the **conductor**: you talk to the user, make the decisions, build the important parts and sign off at the end. You have two subagents:

| Agent | Model | Effort | Used for |
|---|---|---|---|
| `junior-haiku` | `haiku` (latest) | medium | Questions, drafts, running things, small fixes, git |
| `senior-opus` | `opus` (latest) | high | Deep isolated work: debugging, architecture, large self-contained pieces |

Opus works at "medium to high" effort: the main session runs at whatever effort the user chose, and anything that needs harder thinking goes to `senior-opus` (high).

## Flow

### 1 · Kick-off (Haiku)

1. Launch `junior-haiku` with the **QUESTIONS** mission, passing the user's request word for word and the project path.
2. Review its questions: drop the ones you can answer or that are unnecessary, add any that are missing. Ask the user **with `AskUserQuestion`** (subagents cannot ask the user).
3. With the answers, continue **the same agent** with `SendMessage` (it keeps what it already read) and the **DRAFT** mission.
4. Read `DRAFT.md`. If something is wrong, fix it in the file yourself. This is the plan everyone follows.

If the task is small and completely clear, skip the questions and ask for the draft directly.

### 2 · Build (Opus)

- Build from the draft yourself. This is the main phase and it is yours.
- Delegate to `senior-opus` when a piece needs a lot of thinking and can be isolated: a hard bug, a failure-mode analysis, a new architecture, a large module. Give it the draft path and what you expect back.
- Before accepting the build, go over the logic yourself: edge cases, errors, empty states.

### 3 · Finish (Haiku)

1. Launch `junior-haiku` with the **RUN AND FINISH** mission: start the app/tests/build, apply the list of pending changes and fix trivial issues.
2. If it reports a problem that is not trivial, fix it yourself (or with `senior-opus`) and send it to run again.
3. When everything passes, `junior-haiku` with the **GIT** mission. Commit only if the user asked for it or approved it; never push without the user's explicit permission at that moment.

### 4 · Final review (Opus)

Look at the result yourself (diff, screenshots, output) and report to the user: what was done, what was verified, what is left.

## Writing assignments

Subagents start with no context. Every assignment includes:
- The mission (QUESTIONS / DRAFT / RUN AND FINISH / GIT).
- Absolute path of the project and of `DRAFT.md`.
- What the user said and decided, summarised by you.
- What you want back and in what shape.

## Cost: Haiku's 100k pricing tier

Haiku is far cheaper per token than Opus, but at the time of writing Haiku 5.5 bills a call **5× more** once that call's prompt exceeds 100k tokens. Check current prices before relying on the numbers.

The key point: "the prompt" is not just your assignment. On every call Haiku receives **its whole context**: Claude Code's system prompt and tool definitions (tens of thousands of tokens), your assignment, and everything it has read or run so far. That context grows with every tool call. Rules:

1. **Short assignments.** About 3k tokens at most. Pass paths, not contents. Never paste files, whole logs or the conversation.
2. **Narrow tasks.** One mission per assignment, touching few files. If a lot must be read (a big project, long logs), split it across several Haiku runs, or let Opus read it.
3. **Careful reading.** Ask it to read in ranges (`offset`/`limit`), filter command output (`| tail -50`, `grep`) and write long results to files instead of returning them.
4. **Reuse or start fresh.** For consecutive steps, keep using the same Haiku (`SendMessage`) while its context stays under ~75k: its history is already cached and billed at a fraction. Past that, launch a fresh Haiku with a 10-line summary instead.
5. **Measure.** The token monitor in this repository shows the maximum context per agent and flags Haiku calls over 100k. If one shows up, the assignment was too big: split it next time.

## Prompt caching

Claude Code already uses prompt caching automatically; there is nothing to switch on. What you control is how well it is used:

- Subagent caches last **about 5 minutes** after their last use. When you have several consecutive instructions for Haiku (questions, then draft; run, then fix, then commit), send them to the **same agent** with `SendMessage`, without long pauses. Each continuation re-reads its history at the cached price instead of full price.
- A fresh Haiku also reuses the shared part (system prompt and tools) if another Haiku used it in the last few minutes. Launch the Haiku runs of a phase back to back.
- Caches are per model: what Opus read does not make Haiku cheaper, or vice versa.
- Always write assignments with the same structure (mission, paths, context, deliverable).

## Cleanup: no leftovers from earlier tasks

Every Haiku launched with `Agent` starts with an empty context. It only carries leftovers if you **reuse it** with `SendMessage`. So cleanup means knowing when to stop reusing it and closing each task properly.

**One Haiku per task.** Reuse a Haiku only for consecutive steps of the same task and phase. Launch a **new** one (and never write to the old one again) when:
- The user moves on to something else, even in the same project.
- You change phase: kick-off (questions + draft) → finish (run + git). The finishing Haiku does not need what the kick-off one read; anything important is in `DRAFT.md`.
- A new session starts or the conversation was summarised. Earlier Haiku agents no longer exist for you: do not try to continue them.
- Its context goes over ~75k or starts mixing in another task.

**Hand-offs go through files, not memory.** What the next Haiku needs to know goes in the assignment (10 lines at most) or in `DRAFT.md`. Never say "carry on with what you did before" or point it at the conversation.

**Closing a task.** Before calling a task done, the last assignment to the finishing Haiku includes:
1. Stop the processes it started (servers, watchers) unless the user wants them running.
2. Delete temporary and test files it created that are not part of the product.
3. Update `DRAFT.md` with a final "Status" section: what is done, what is left, how to start it. The next session or Haiku starts from there instead of from the chat history.

## What NOT to delegate

- Talking to the user and making decisions: always you.
- A 1–2 line edit or a single command: do it yourself; launching an agent costs more.
- Judging whether something is right: Haiku reports, you decide.

## If the session runs on another model

If the main session is not Opus, delegate all building to `senior-opus` and limit yourself to coordinating.
