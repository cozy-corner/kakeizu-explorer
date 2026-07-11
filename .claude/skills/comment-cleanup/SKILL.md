---
name: comment-cleanup
description: Use to correct over-commenting in this repo — code comments that merely restate what the code already says (labels on obvious assignments, control-flow conditions, loop bounds) or narrate line-by-line. Deletes pure what-comments, rewrites partly-useful ones into the non-obvious why, and normalizes Japanese code comments to English. Trigger whenever the user asks to clean up / prune / fix / 訂正する comments, remove redundant or excessive comments, or review comments for a diff or a set of files. Runs on the uncommitted diff by default, or on paths you pass it. Comments only — it never changes code behavior. NOT for writing new docs or prose.
---

# Cleaning up over-commenting

**Start from zero comments.** The default state of any line is _no comment_. A comment
is not free — it costs a line, drifts out of sync with the code, and trains the reader
to skim past comments entirely. So a comment does not get to stay just because it's
"not wrong" or "kind of helpful." It stays only when it pays for itself by telling the
reader something the code **cannot**: a non-obvious _why_. The burden of proof is on
the comment, not on the deletion.

If you imagine the file with every comment stripped out, then add back only the ones a
competent reader would genuinely miss — that's the target state. Most restating
comments never make the cut.

This is a quality pass, like `/simplify` but scoped to comments. **You only touch
comments — never the code they sit on.** Behavior must be identical afterward.

## Scope

- If the user passed file paths or a directory, work on those.
- Otherwise work on the **uncommitted diff**: `git diff HEAD --name-only` for the
  changed files, and only judge comments on or adjacent to changed lines. Don't go
  reformatting comments the user didn't touch — that buries their real change in noise.

## The one question

For every comment, the comment must justify why it exists. Ask: **would a competent
reader who deleted this comment actually lose something the code doesn't say?**

- **No** → the comment failed to justify itself. Delete it (or, if it holds a fragment
  of real rationale buried in restatement, rewrite it down to just that rationale).
- **Yes** → it's carrying non-obvious information the code can't. Keep it.

That's the whole rule. Note the default answer is _delete_ — a comment you can't
clearly defend has not earned its line. Everything below is calibration.

### Judge at the sentence level, not the block level

Apply the one question to **each sentence**, not to the comment as a whole. A real
_why_ does not grant amnesty to a restating sentence sitting next to it. The most
common miss is a leading what-sentence glued in front of a genuine why:

```ts
// Capture the x of the first node seen in each column.        ← restates the code below
// dagre's per-rank x is not guaranteed to be a fixed multiple, ← real why: keep
// so we can't just compute col * SPACING.
if (!colX.has(n.col)) colX.set(n.col, n.x);
```

The second sentence earns its place; the first is exactly what `colX.set(col, x)` does.
Keeping the block whole because "it contains a why" leaves the restatement behind —
delete the first sentence, keep the rest. Same for a trailing "…, so we do X" tacked
onto a description: keep the _so-clause_, drop the description.

## Delete: pure what-comments

These restate the mechanics. The code is the better documentation of itself.

```ts
// increment the counter          ← delete
i++;

// set the name                   ← delete
this.name = name;

// loop over children             ← delete
for (const c of children) { … }

// x is uniform within a column   ← delete: the assignment below says exactly this
if (!colX.has(col)) colX.set(col, p.x);
```

Signals a comment is pure-what: it's a prose translation of one statement; it repeats
the identifiers already on the line; removing it loses nothing a reader couldn't
recover in one glance.

## Keep: non-obvious why

These survive because the code can't express them. Do **not** delete these.

```ts
// A Driver owns a connection pool, so create exactly one per process.
// dagre's per-rank x is not guaranteed to be a fixed multiple, so capture it here.
// A child with two recorded fathers keeps BOTH rather than picking one — avoids a
// non-deterministic choice between disputed parents.
```

What makes a comment worth keeping: a rationale ("so that…", "because…"), a gotcha or
constraint ("dagre doesn't guarantee…"), a workaround and the reason for it, domain
semantics a non-expert wouldn't know (家督, 養子, patrilineal reduction), or a pointer
to why an obvious-looking alternative was _not_ taken.

## Exception: doc comments on public API

Zero-based governs _implementation_ comments — the ones inside a function body
explaining the mechanics. It does **not** apply to a doc comment on an **exported /
public** class, function, type, or constant. A caller reads the signature and its doc,
not the body, so a short doc that states the _contract_ (what it does, its params,
return, thrown errors, units) earns its place even though a reader of the body could
"derive" it. That's the point — the doc saves them from reading the body.

So: keep a minimal doc comment on public API. If one is missing you don't have to add
it (that's not this skill's job), but never strip an existing sensible one just because
it restates behavior — for public surface, stating the behavior _is_ the contract.

**"Keep" does not mean "leave verbose."** The exemption is for a _minimal_ contract
doc, not a license for bloat. Trim a rambling or multi-paragraph public doc down to the
essential contract — one or two lines — dropping restated implementation detail,
obvious param lines (`@param name the name`), and filler. Apply the same sentence-level
cut here: keep the contract sentences, delete the padding.

Two limits so this doesn't become a loophole:

- The exemption is for a doc that describes the **contract**, not for any comment that
  happens to sit above a public symbol. A comment describing one _internal step_
  (`// capture the first x per column`) placed at the doc position is still an
  implementation comment — judge it by zero-based, not by its location.
- A doc that only re-says the name (`/** Gets the driver. */` over `getDriver()`) adds
  nothing a caller couldn't read off the signature — that one still goes.

Private / non-exported helpers get no such exemption: their only reader is someone
already in the file, so the body is the documentation.

## The gray zone — labels

Terse labels on control flow are the hard case. Some merely re-say the condition in
English; those go. A few name a _domain concept_ the code can't — those can stay, but
they still have to clear the zero-based bar.

```ts
// not a co-located couple          ← delete: just re-says `mp.col !== fp.col`
if (mp.col !== fp.col) continue;

// married-in: patrilineal view drops a mother's descent, so she has no parent edge
if (!hasParentEdge(p)) continue;    ← keep: names 家督/血統 semantics the code can't
```

The test for a label: strip it, and ask whether a reader who knows TypeScript but not
this domain would still understand _why_ the branch exists. If the code alone answers
that, the label was restatement — delete it. Only genuine domain meaning survives.

Because we start from zero, **when you can't articulate what a label adds beyond the
code, delete it** — an undefendable comment hasn't earned its line. Don't keep a
comment merely because removing it feels aggressive; keep it only because you can name
the non-obvious thing it carries.

## Delete: stale-by-design comments

Some comments describe a _point in time_ rather than the code as it now stands. They
rot the moment the surrounding history moves on, and the code plus git already hold the
truth. Delete them even when they read like a "why":

- History/change narration: "previously returned null", "used to be a callback",
  "changed from X to Y". The current code is the current behavior; the old behavior
  lives in git, not in a comment.
- PR / issue / ticket numbers: "// fix for #57", "// see PR #60", "// per JIRA-123".
- Phase / milestone references: "// phase 2", "// temporary until the migration".
- Bare dates and "new"/"recently added" markers, which are stale within a release.

The rare exception is when the _reason a past choice still constrains the present_ is
non-obvious and load-bearing — then keep the **rationale**, but strip the bookkeeping:
rewrite "// workaround for bug #4123 in dagre 0.8" down to "// workaround: dagre 0.8
mis-ranks equal-order nodes" if that constraint still governs the code. Keep the why,
drop the ticket number.

## Rewrite: partial-value comments

Some comments are half redundant, half useful — they state the what but gesture at a
why. Don't delete the baby with the bathwater; rewrite to keep only the why.

```ts
// offset from the couple's live midpoint          ← restates the formula below
const dOrder = (fp.order + mp.order) / 2 - cp.order;

// rewritten — drop the "offset from midpoint" (the formula shows that), keep the why:
// re-centres the child when a spouse moves during routing
const dOrder = (fp.order + mp.order) / 2 - cp.order;
```

If you can't articulate a real why after reading the surrounding code, don't invent
one — just delete the what-part. Never fabricate rationale to justify keeping a comment.

## Normalize: Japanese code comments → English

This repo's policy is **code comments in English, prose docs in Japanese**. When a
code comment is written in Japanese, translate it to English as part of the cleanup —
_unless_ it's a domain term with no clean English equivalent (家督, 養子, 養父, QID
labels), which stay as-is inside an otherwise-English comment. Don't touch comments in
`.md` docs; those are meant to be Japanese.

## Finish

- Re-read your diff: every change must be a comment-only edit. If you touched a line of
  code, revert it.
- Report what you did as a short list grouped by action (deleted / rewritten /
  translated), with `file:line`, so the user can eyeball the judgment calls — especially
  any gray-zone keeps you were unsure about.
- Don't run the test suite for a comment-only change; there's nothing behavioral to
  verify. Do confirm the file still parses if your editor/LSP flags anything.
