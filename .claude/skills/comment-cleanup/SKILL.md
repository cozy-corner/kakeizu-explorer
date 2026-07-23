---
name: comment-cleanup
description: Use when the user asks to clean up / prune / fix / 訂正する code comments, remove redundant or excessive comments, cut comment volume, or review the comments on a diff or a set of files. Also trigger when a change adds comments that restate what the code already says or over-explain it. Scoped to code comments only — never writes new docs or prose, never changes code behavior.
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

The scope is always **a diff** — its changed files, and only the comments on or
adjacent to its changed lines. Never reformat comments the diff didn't touch; that
buries the real change in noise. What supplies the diff differs by input:

- **A diff range** (e.g. `main...HEAD`) — use it: `git diff main...HEAD --name-only`
  for the files, and judge only comments on or adjacent to lines that range changed.
  This is how to scope a branch whose work is already committed — pass the range, not
  the paths, so the changed-lines restriction survives.
- **File paths or a directory** — work on those files. Note this loses the
  changed-lines restriction (it judges every comment in the file), so prefer a range
  when you have one and only fall back to paths for a whole-file pass.
- **Nothing** — default to the **uncommitted diff**: `git diff HEAD --name-only`, same
  changed-lines rule.

## The one question

The **reader** this test assumes: fluent in the language and libraries in play, but
_not_ in this project's domain or its other modules. "Recoverable" always means
recoverable by _that_ reader — it's why a domain-grounded _reason_ (why the code treats
諸説 or 家督 the way it does) stays, while a plain-language because — or a bare gloss of the
term itself — goes.

For every comment, ask: **could that reader recover this comment's justification by
reading the visible code, or does it live _outside_ the code entirely?**

- **Recoverable from the code** → delete it. This is the whole point most cleanups miss:
  it applies to a _why_ just as much as a _what_. A "we do X so that Y" whose Y is right
  there in the next three lines is a restatement wearing a because. The code is the
  proof; the comment is a slower copy of it.
- **Outside the visible code** → keep it (compressed — see below). Only a handful of
  things qualify: an **external fact** the code can't encode (a library's guarantee, a
  browser quirk, `dagre` doesn't promise X), a **rejected alternative** and why it fails
  (the code shows the road taken, never the one refused), a **domain-grounded rationale**
  — a why that turns on a domain fact a non-expert couldn't supply (諸説 disputed parentage
  → keep both fathers; 家督 succession is not descent → drop it); the domain term rides
  along in the reason, it is not — save the flagged
  no-constant stopgap below — kept as a bare gloss (P22 = father, 家督 = house-headship;
  that meaning's home is a constant or external rule, not a comment), a **caller-side
  precondition** the body can't show ("caller holds the lock", "input validated
  upstream"), or the **contract of a public API** (a caller reads the signature, not the
  body). Nothing else.

The bar is "無いと困る" — would a reader be _stuck_ without it, or merely told again what
they just read? Default is _delete_. Everything below calibrates the things that fool
people into keeping — derivable whys, invariant declarations, padded blocks — and the
one thing that fools people into deleting: a real non-local fact they couldn't articulate
on the spot (keep-and-flag it; see below).

One exception the headline test alone gets wrong — an **invariant declaration** that is
true because of code _elsewhere_, yet still goes (its home is a `throw`/type/assert, not
prose) — is handled in "Invariants belong in code" below.

### The taxonomy — the four core kinds (stale / label / partial-value cases follow below)

| Comment                                                                             | Recoverable?                | Verdict            |
| ----------------------------------------------------------------------------------- | --------------------------- | ------------------ |
| **what-restate** — prose translation of one statement (`// increment i` over `i++`) | yes                         | delete             |
| **derivable why** — a because whose reasoning is visible in the code below it       | yes                         | delete             |
| **invariant declaration** — "X always holds here"                                   | should be code, not prose   | delete (see below) |
| **external / rejected-alt / domain-rationale / public-contract**                    | no — lives outside the code | keep, compressed   |

### Judge below the block: sentence, then clause

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

**Go below the sentence: a restating clause or parenthetical embedded _inside_ a
kept why-sentence still gets cut.** The common miss is an enumeration glued mid-sentence
— you keep the sentence for its why and the list rides along:

```ts
// every persisted attribute (label, sex, nationalities, wikipediaTitle) is
// captured once via attrs.ts        ← keep the why "captured once"; cut the list
```

The parenthetical just names the fields of a type (`RawNode`) — self-evident from the
type, so it's inventory the code already holds: **recoverable from the type → cut it,
keep the why** ("captured once"). (It also drifts — a reviewer flags it as _incomplete_
when a field is added, and the fix is to delete the list, not complete it — but
recoverability is the reason; drift is only the symptom.)

A domain-identifier gloss — `// P22 = father` — maps an opaque token to its meaning, whose
real home is a **named constant** (`const FATHER = "P22"`): resolved once, no drift. So if
a constant (or an earlier gloss) already carries the meaning, the gloss just repeats it →
cut. If no constant exists and the code uses the raw token, deleting the gloss forces an
external lookup on every reader — worse than keeping it — so **keep-and-flag** the _single_
definitional gloss (note it wants a constant) and cut only its repeats. What never gets cut
is a domain-grounded _rationale_ the term rides inside ("keep BOTH fathers — 諸説 disputed,
picking one fabricates a bloodline"). Apart from the single no-constant stopgap above, a
bare "P22 = father" is not kept for itself — and that surviving gloss sits at the point of
use (beside the raw token), not wherever a rationale happens to mention the term.

Cut only inside **implementation** comments — a public-API contract doc may legitimately
enumerate its params/fields (see the Exception on public API).

### Compress the padded block

The volume problem in this repo is rarely a stray what-comment — it's a five-to-eight
line block wrapped around _one_ load-bearing sentence. Every sentence is "not wrong", so
a block-level judgment keeps the whole paragraph. Run the sentence test on each one and
almost all of it is derivable narration of the code below.

```ts
// Resolve who tucks beside whom, as host → its directly-attached spouse ids:      ← derivable (the code does this)
// a married-in spouse rides beside the in-tree partner it married (preferring the  ← derivable
// focus when it married more than one in-tree relative), and the focus's own       ← derivable
// spouse rides beside the focus even when that spouse heads their own blood line.   ← derivable
// Transitive co-spouses are reached by walking the map (a tucked spouse may host    ← derivable
// its own). Depends only on edges, the present node set, and the focus column —     ← KEEP: the one
// not on order — so it's stable however the tidy layout stacks the column.          ← non-local why
function tuckHosts(...)

// compressed to the load-bearing sentence:
// Reads only edges + the focus column, never order — so it's stable however the
// tidy pass later stacks the column.
function tuckHosts(...)
```

The six description sentences retrace what the function body plainly does. The survivor
isn't the "reads only edges" phrasing — you _can_ see which variables the body touches.
It's the **consequence that points elsewhere**: the ordering-independence _holds despite
a later pass (the tidy layout) that this function can't see_, and that constraint is what
a future editor would break by making it depend on order. Keep the block only for that
kind of reach-outside-the-function fact, phrased as the constraint, not the var list.

Compress hard: a kept block should be one or two sentences, not a paragraph.

**Guard against over-cutting.** "Default is delete" governs comments you can fully
account for. If a block plainly gestures at code _elsewhere_ — another pass, another
module, a caller — but you can't crisply name the property, that's a signal you may be
missing a real non-local fact, not proof there is none. **Keep-and-flag** it (leave it,
note it to the user) rather than delete. Only delete a block outright when every sentence
is accounted for by the visible code.

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

## Delete: derivable why

The trap. A comment in "because / so that" form _feels_ load-bearing, but if its
reasoning is sitting in the code right below it, deleting it loses nothing — the reader
reconstructs it in one read. A because is not a free pass; it has to point _outside_ the
code to earn its line.

```ts
// an unshared column contributes -Infinity so it never binds   ← delete: derivable why
const shift = Math.max(
  0,
  ...tops.map(([c, t]) => (bottom.has(c) ? bottom.get(c)! + 1 - t : -Infinity)),
);
```

The `-Infinity` in the ternary _is_ "never binds" — the comment is a prose trace of the
expression, and a reader who knows the language recovers it in one read. → delete.
(Note: a clause like "the 0 floor keeps a subtree from sliding up" is borderline — the
`Math.max(0, …)` shows the clamp, but "sliding up" edges toward layout intent. When a
clause reaches for intent that isn't in the code, treat it as a why and run the outside-
the-code test on it, rather than assuming it's pure mechanics.)

Test for a why: cover the comment and read only the code. If you can state the same
rationale from the code alone, the comment was derivable — delete it. Keep it only when
the code cannot get you there.

## Keep: non-obvious why

These survive because their justification is **not in the code at all** — no amount of
reading the function recovers it. Do **not** delete these.

```ts
// dagre's per-rank x is not guaranteed to be a fixed multiple, so capture it here.
//   ↑ external fact about dagre — nowhere in this code
// falling back to col would project the bucket index as a pixel — a far-left ghost.
//   ↑ a rejected alternative; the code only shows the path taken
// A child with two recorded fathers keeps BOTH rather than picking one — avoids a
// non-deterministic choice between disputed parents.
//   ↑ domain reason (disputed parentage) the code can't state
```

The only things that qualify: an **external fact / constraint** (a library or platform
guarantee the code can't encode), a **rejected alternative** and why it fails, a
**domain-grounded rationale** (a why that turns on a domain fact, like the
disputed-parentage line above — not a bare gloss of a term; `P22 = father` / `家督 =
house-headship` is a constant or external rule, not a keep), or a **public API contract**.
A bare "so that…/because…" whose answer is in the code is NOT one of these — see the
derivable-why section above.

## Invariants belong in code, not comments

A comment that _declares_ an invariant — "X is always true here", "this can never miss",
"the list is non-empty by now" — is not a why. It's an assertion, and an assertion's
home is the code: a `throw`, a type, a guard, a validation. So:

```ts
// Every col a pass emits is always a colX key, so this lookup can never miss.
//   ↑ delete: the invariant is already enforced two lines down —
const x = colX.get(col);
if (x === undefined) throw new Error(`column ${col} not present`); // ← this IS the invariant
```

- If the code **already enforces** the invariant (a `throw`, a schema, a type), the
  comment restates it → delete.
- If the code **could** enforce it locally but doesn't, the fix is to add the
  `assert`/`throw` — a code change, out of scope. Still delete the comment; don't leave
  an unenforced promise in prose. Flag it to the user if it looks load-bearing.

**Do NOT lump caller-side preconditions in here.** A precondition the body _cannot_
enforce — "caller must hold the lock", "input is already validated upstream", "list is
non-empty because the caller guarantees it" — is an **outside-the-code fact** (a contract
with the caller), not a local invariant. It's in the keep list; **keep it** (compressed),
don't delete. The test: could this function _add a `throw`_ to check it? If yes → local
invariant, delete the prose. If the guarantee lives at the call site and the body has
nothing to assert → precondition, keep it.

The other thing near an invariant that survives is the **why of a non-obvious enforcement
choice** — e.g. why a `throw` beats a silent fallback (a rejected alternative), which
lives outside the code. Keep that; drop the "always holds" sentence.

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
English; those go. A label survives only when it carries a domain-grounded _reason_ for
the branch — a why that turns on a domain fact the code can't supply. Merely _naming_ the
domain concept the branch acts on is a gloss, and a gloss is a cut (its home is a constant
or the term itself, not a comment).

```ts
// not a co-located couple          ← delete: just re-says `mp.col !== fp.col`
if (mp.col !== fp.col) continue;

// married-in: patrilineal view drops a mother's descent, so she has no parent edge
if (!hasParentEdge(p)) continue;    ← keep: the domain *reason* the branch exists
```

The second stays not because it names 家督/血統, but because it states _why_ the branch
skips these nodes — the patrilineal reduction drops a married-in mother's descent, so she
has no parent edge — a domain fact a non-expert couldn't recover from the code. A bare
`// married-in` label naming the concept without the reason would go.

The test for a label: strip it, and ask whether a reader who knows TypeScript but not
this domain would still understand _why_ the branch exists. If the code alone answers
that, the label was restatement — delete it. Only a domain-grounded reason survives;
naming the concept alone does not.

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

## Red flags — you're keeping a comment you should cut

| Thought                                        | Reality                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| "It's a why, not a what"                       | A why whose answer is in the code is derivable — delete it. Only outside-the-code whys stay.  |
| "It explains the reasoning"                    | If reading the code gives the same reasoning, the comment is a slow copy. Cover it and check. |
| "Every sentence is technically true"           | True ≠ load-bearing. Judge each sentence; a padded block of true sentences still goes.        |
| "It documents an important invariant"          | Invariants live in `throw`/type/assert, not prose. Delete the declaration.                    |
| "Deleting this feels aggressive"               | Zero-based: undefendable = delete. Aggression isn't the test; "無いと困る" is.                |
| "The block contains a real why, keep it whole" | Compress to that one sentence; don't keep six for the sake of one.                            |

## Finish

- Re-read your diff: every change must be a comment-only edit. If you touched a line of
  code, revert it.
- Report what you did as a short list grouped by action (deleted / rewritten /
  translated), with `file:line`, so the user can eyeball the judgment calls — especially
  any gray-zone keeps you were unsure about.
- Don't run the test suite for a comment-only change; there's nothing behavioral to
  verify. Do confirm the file still parses if your editor/LSP flags anything.
