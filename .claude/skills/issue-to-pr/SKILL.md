---
name: issue-to-pr
description: >-
  End-to-end workflow for taking a task or GitHub issue all the way to an opened,
  review-clean PR. It sequences: read the issue/plan and clarify unknowns →
  EMPIRICALLY VERIFY the load-bearing assumption before writing code → implement
  in a git worktree → self-review with /code-review and triage the findings →
  open the PR → triage the PR bot's review the same way. Use this whenever the
  user wants to 進める / implement / build / refactor an issue or feature through
  to a PR, or to ACT ON (apply the valid ones, reject the rest with a reason)
  code-review or PR-review findings. Prefer it over jumping straight to coding: it
  bakes in the assumption-checking, worktree isolation, and disciplined
  finding-triage that ad-hoc work skips. NOT for one-off single-file edits, for
  design-discussion-only with no implementation, or for merely fetching or
  displaying a PR's reviews without acting on them — those belong to design,
  simplify, or pr-reviews respectively. Delegates each phase to the focused skills
  (design, code-review, pr-reviews) and may fan out to parallel agents.
---

# Issue → PR

An orchestrator for shipping a change well, not just fast. It strings together
skills you already have and adds the two habits that separate a clean delivery
from a messy one: **proving the assumption your design rests on before you build
on it**, and **judging review findings instead of reflexively applying them**.

Run the phases in order. Each links to the skill that owns its details; this file
owns the _sequence_ and the _judgment_. You don't need every phase for every task
— a one-line fix skips straight to implement — but don't skip a phase to save
time on something non-trivial. The phases exist because each prevents a specific,
expensive failure.

## Phase 1 — Understand & clarify

Invoke the **design** skill: read the actual code/issue/plan-doc first, cite
file:line, write a short plan, and STOP for approval. While reading, collect the
genuinely-unresolved questions — the ones the issue does not answer and you can't
settle from the code or a sensible default — and ask them with `AskUserQuestion`.

Ask only what changes what you'll do. A decision with an obvious default isn't a
question; pick it, state it, move on. The bar for asking is "the answer changes
the artifact," not "I'm slightly unsure."

## Phase 2 — Verify the load-bearing assumption (before any code)

Every non-trivial plan rests on one or two assumptions that, if false, sink the
whole approach. Name them, then **prove them with a throwaway probe** before you
write the real code — not after, when the cost of being wrong is a rewritten PR.

The probe is a small script that measures the real system, not a thought
experiment. Put it in the repo's `scripts/` (versioned, per the repo's
conventions), run it, read the number, and only then commit to the design. Delete
it once it has served its purpose unless it's reusable.

> Example (this came from a real session): a refactor moved layout from pixels to
> `{col, order}` structural coords, betting that "dagre gives every node in a rank
> the same x." Before touching the engine, a 40-line probe bucketed every node by
> `round(x)` across 10 real graphs and printed the max intra-bucket spread:
> `0.000e+0`. _Then_ the refactor proceeded. Had it been non-zero, the entire
> `colX` design was wrong — caught in 2 minutes instead of a re-done PR.

If you cannot prove an assumption cheaply, say so and mark it a risk in the plan
rather than asserting it. A design built on an unverified "x is uniform" is
speculation; one built on a printed `0.000e+0` is engineering.

## Phase 3 — Implement (in a worktree)

Create the worktree **from the start** — never branch in the main checkout. Use
the project's worktree runner if it has one (`git gtr new <branch> --from <base>`),
otherwise `git worktree add`. This is non-negotiable: it keeps the main checkout
clean and lets long verification runs and the dev server coexist with edits.

Match the surrounding code's idiom. For a **behavior-preserving change** (refactor,
extraction, rename), set up a mechanical guard that proves equivalence — a parity
script diffing old vs new output, a golden-dump diff, byte-level where possible —
and run it. "I read it carefully and it looks equivalent" is not evidence;
`PARITY OK: identical on every graph` is. Keep `tsc`/lint/test/build green as you
go, not at the end.

## Phase 4 — Self-review and triage

Run `/code-review medium` (the **code-review** skill: it fans out finder + verifier
agents — that's the agent team, already wired). Then do the part the tool can't:
**triage every finding** with the rubric below. Apply the valid ones (one commit
per finding), and for each rejection say _why_ in your summary to the user. Don't
silently drop a finding and don't reflexively apply one.

## Phase 5 — Open the PR

Once review is clean and the guard is green, push the worktree branch and open the
PR (gh). Write the body so a reviewer sees _what changed, how it was verified, and
what's deliberately out of scope_ — include the assumption-probe result and the
parity/guard evidence, and link the issue. Commit/push only when the user has asked
to proceed to a PR; opening it is outward-facing, so confirm if unsure.

## Phase 6 — Triage the PR review

**First, wait for the bot review to land** (it isn't posted at push time).
Launch one bounded background waiter — a `gh pr checks <n>` loop that returns
when the check leaves `pending`, capped at ~15 min — so the harness notifies you
on completion. If it times out, tell the user; don't re-arm. Then fetch.

Fetch the PR's comments and bot review with the **pr-reviews** skill (handles
pagination + CodeRabbit nitpicks). Run the **same triage rubric** on every finding.
Apply the valid ones; for the rejected ones, reply on the PR with the reason so the
bot doesn't re-raise them on the next push. Re-run the guard after any change.

---

## The triage rubric (Phases 4 and 6)

A reviewer — human or bot — surfaces _candidates_. Your job is to decide which a
maintainer would actually act on. For each finding, verify against the real code
(trace it; don't trust the summary), then classify:

**妥当 / apply** — a real problem this change _introduced or worsened_, inside the
task's scope, with a nameable failure. These you fix.

**却下 / reject** — for one of these reasons, which you must state:

- **Pre-existing, not introduced here.** The change faithfully preserved old
  behavior; the finding is about code that already behaved this way. Out of scope
  for the current change — note it (or file a separate issue), don't fold it in.
  _Verify this by checking the old code_: e.g. a "use trueParentsOf not fatherOf"
  suggestion was rejected once it was confirmed the old cytoscape code used the
  same drawn-fathers set — the refactor changed nothing.
- **Out of scope.** Correct in the abstract but would _change behavior_ in a
  behavior-preserving PR, or expands past the task. Defer.
- **Refuted.** Factually wrong, or already guarded elsewhere. Quote the line that
  proves it.
- **Negligible.** Mechanism real but impact below the threshold that matters
  (sub-pixel, proven non-manifesting by the guard). Note and move on.

Two failure modes to avoid, equally: **performative agreement** (applying a
suggestion because a bot said it, without checking it's real or in scope) and
**dismissiveness** (rejecting a valid catch because it dents your work). The
`/code-review` and PR-bot outputs are _inputs to your judgment_, not orders.

When a finding targets code _you just added_ in this change, it's in scope by
definition — fix it properly. (E.g. a `colX.get(x)!` non-null assertion was flagged
as not actually throwing at runtime; that's your own new line, so it got an explicit
`throw`, plus a regression test.)

## Using agent teams

Phases naturally fan out, and that's encouraged:

- `/code-review` already runs parallel finder + verifier agents.
- A heavy assumption check or a cross-cutting triage can spawn parallel agents
  (see **dispatching-parallel-agents**) — one per file/angle/finding — when the
  work is independent. Keep the _conclusion_, not the file dumps.
- When you dispatch a subagent for search/verification, tell it to use Grep/Glob/
  Read rather than shell `grep`/`find`/`cat`, and to return only the verdict.

Keep yourself in the loop between phases: read each result and decide the next
step. The orchestrator is you; the agents are leverage.
