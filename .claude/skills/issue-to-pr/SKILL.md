---
name: issue-to-pr
description: >-
  End-to-end workflow for taking a task or GitHub issue all the way to an opened,
  review-clean PR. It sequences: read the issue/plan and clarify unknowns →
  implement in a git worktree (optionally de-risking a shaky assumption with a
  throwaway probe first) → clean it up with /simplify and self-review with /code-review,
  triaging the findings → verify it works by running it → open the PR →
  triage the PR bot's review the same way. Use this whenever the user
  wants to 進める / implement / build / refactor an issue or feature through to a
  PR, or to ACT ON (apply the valid ones, reject the rest with a reason)
  code-review or PR-review findings. Prefer it over jumping straight to coding: it
  bakes in worktree isolation, behavioral verification, optional assumption
  de-risking, and disciplined finding-triage that ad-hoc work skips. NOT for one-off
  single-file edits, for design-discussion-only with no implementation, or for
  merely fetching or displaying a PR's reviews without acting on them — those
  belong to design or pr-reviews respectively. Delegates each phase to the focused
  skills (design, verify, simplify, code-review, pr-reviews) and may fan out to
  parallel agents.
---

# Issue → PR

An orchestrator for shipping a change well, not just fast. It strings together
skills you already have and adds the habit that separates a clean delivery from a
messy one: **judging review findings instead of reflexively applying them**. When
the design happens to rest on a shaky empirical assumption, it also de-risks that
cheaply before you build on it — an optional step, not a gate.

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

### Optional: de-risk the load-bearing assumption first

Not a phase — a conditional technique. **Skip it unless the design genuinely rests
on an unproven empirical assumption** (how real data behaves, what a library
actually does). Most changes — UI tweaks, straightforward CRUD, copy — have no such
assumption; go straight to Implement.

When there _is_ one and it would sink the whole approach if false, prove it cheaply
before writing the real code: a small throwaway script in `scripts/` that measures
the real system, run once, read the number, then commit to the design (delete it
after unless reusable). This is a lightweight **spike**, standard de-risking — not a
mandatory gate.

> Example (a real session): a refactor bet that "dagre gives every node in a rank
> the same x." A 40-line probe bucketed every node by `round(x)` across 10 graphs
> and printed the max spread: `0.000e+0`. _Then_ the refactor proceeded — a wrong
> bet would have cost a re-done PR instead of 2 minutes.

If you can't prove it cheaply, mark it a risk in the plan rather than asserting it.

## Phase 2 — Implement (in a worktree)

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

Once it's implemented, **verify it works** — invoke the **verify** skill and drive
the actual change to confirm it does what the issue asked, before spending cleanup
effort on it. Keep `tsc`/lint/test green throughout as the continuous signal; verify
is the behavioral confirmation on top. If it doesn't work, fix it here — don't carry
a broken change into review.

## Phase 3 — Simplify, self-review, and triage

Two passes over the diff, each owned by a focused skill:

- **simplify** — run `/simplify` first. It does the quality pass: reuse existing
  helpers, collapse needless complexity, fix inefficiency and altitude, then applies
  the fixes. It does _not_ hunt for bugs — that's the next pass. Review what it
  changed like any other edit; keep the parity guard green.
- **code-review** — then run `/code-review medium` (fans out finder + verifier
  agents — that's the agent team, already wired). Do the part the tool can't:
  **triage every finding** with the rubric below. Apply the valid ones (one commit
  per finding), and for each rejection say _why_ in your summary. Don't silently
  drop a finding and don't reflexively apply one.

Run simplify before code-review so the review sees the cleaned-up diff, not code
you're about to rewrite. Both rewrite code, so Phase 4 re-verifies before the PR.

## Phase 4 — Re-verify (confirm the cleanup preserved behavior)

Phase 2 established that it works; simplify and code-review are behavior-preserving
_by intent_, not confirmed. Re-run the Phase 2 verification on the paths the cleanup
touched — a rewrite is exactly where preserved behavior quietly breaks.

Scale it to what changed: if the cleanup was purely structural and a parity guard is
green, the guard is your evidence; if simplify or an applied finding touched a
user-visible path, drive that path again the way Phase 2 did.

Either way, note what you observed (screenshot, output, before/after, or the guard
result) so it can go in the PR body.

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

## The triage rubric (Phases 3 and 6)

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
