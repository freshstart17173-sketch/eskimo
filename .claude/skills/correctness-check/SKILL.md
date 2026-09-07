---
name: correctness-check
description: Use this before implementing, changing, or reviewing any nontrivial system with real timing, state, or sequencing logic — audio/video playback and scheduling, queues, multi-step workflows, anything wired to a clock or an external event, anything where "does it currently work" and "is it actually correct" can diverge. Derives the correctness requirements from first principles BEFORE reading the implementation, so bugs the current code and its own existing tests both quietly agree on (and therefore both miss) actually get caught, instead of re-confirming whatever the code already assumes. Trigger this whenever asked to fix a bug that's intermittent or "only wrong sometimes", audit or review the correctness of an existing system, design or implement a new stateful/sequenced feature, investigate why passing tests didn't catch a real bug, or when about to write a test that would just encode what the code currently does. Also trigger on phrases like "why does this only work sometimes", "the tests pass but it's still broken", "make sure this is actually correct", "audit the logic", or "thoroughness check".
---

# Correctness check

## The one thing this exists to prevent

A test written by the same person, in the same sitting, as the
implementation it tests inherits that implementation's assumptions. If the
code assumes "a manual skip should behave exactly like the automatic
timed handoff", a test asserting exactly that will stay green forever —
right through the bug, because the bug and the test share the same wrong
premise. Passing tests only prove the code does what its author *thought*
it should do. That is a much weaker claim than "the code is correct", and
treating it as the same claim is how the same class of bug keeps coming
back after being "fixed" — the fix was to the code, not to the premise the
tests are the code's own alibi rather than independent evidence.

The fix is ordering, not effort: derive what's *actually* required before
looking at what's *currently there*. If the spec comes from reading the
code, it will describe the code — bugs included — no matter how carefully
it's written afterward.

## The process

**1. Write the spec first, from first principles, before reading the
implementation in detail.** Ask: what is this system *for*? What are the
real inputs, states, and transitions it has to handle, independent of any
particular codebase? Write this as concrete, testable scenarios — plain
language or pseudocode, whichever makes each scenario checkable
("if X happens while in state Y, Z must happen, and specifically not W").
If a session-history summary, code comments, or an existing doc already
describe the *intended* behavior, that's fair source material — it's the
*current implementation and its own tests* that must stay off-limits at
this stage, since those are exactly what might be wrong.

If the user has already stated the intended behavior directly (their own
words, not a guess), that statement outranks anything inferred from
reading code — write it into the spec verbatim rather than rephrasing it
into something weaker.

**2. Only now, read the actual implementation — end to end, not just the
file that seems relevant.** Trace every real call path for each scenario
in the spec: what actually executes, in what order, under what race
conditions. Note every place two independent code paths are supposed to
produce the same result (e.g. two screens sharing one model, a timer and a
manual action sharing one handler) — those seams are exactly where
"fixed it here, forgot it there" bugs live.

**3. Check the implementation against the spec, scenario by scenario —
never the reverse.** For each scenario, does the traced code path actually
satisfy it? A divergence is a finding regardless of whether a test
currently passes; a passing test that asserts the divergent (wrong)
behavior is not a defense, it's part of the finding.

**4. Classify every finding honestly — don't round up to "bug" or down to
"fine":**
- **Confirmed bug** — the code contradicts a requirement that's actually
  settled (stated by the user, or unambiguous from the system's own
  purpose). Fix it.
- **Missing feature** — the requirement is settled but nothing implements
  it at all. Say so plainly; don't quietly bundle a half-guess at it into
  an unrelated fix.
- **Open design question** — the "correct" behavior genuinely isn't
  decided yet (e.g. two reasonable options exist and the user hasn't
  picked). Do **not** guess and implement one silently — that just
  produces the next round of "why does it do THAT". Name the question and
  the options, and leave it for a decision.
- **Architectural limitation** — the finding is real but fixing it
  properly is a redesign, not a patch (e.g. a reactive polling loop can't
  be made sample-accurate by tweaking its interval). Say what a real fix
  would require and why a quick patch would just be theater; a contained
  mitigation is fine to ship alongside that note if one genuinely helps.

**5. Fix what's actually fixable within scope now; don't let "found more
than expected" turn into scope creep.** A missing feature or an open
design question is a finding to report, not an invitation to improvise an
implementation for it in the same pass.

**6. Persist the spec and the findings as a real doc in the repo, not just
as chat output.** The whole point is that the next person (or the next
session) doesn't have to re-derive this from scratch, and doesn't quietly
regress a fixed bug because the reasoning behind the fix lived only in a
conversation that already scrolled away.

## Worked example

`docs/playback-model.md` in this repo is a full worked example: a
first-principles pseudocode spec for the audio playback engine, checked
against the actual implementation (`audioEngine.js`, `App.jsx`'s tick
loop, `PerformPage.jsx`/`LivePerformPage.jsx`), with each finding
classified per the scheme above. It found, among others:

- A confirmed bug where a manual Skip button silently played out a wired
  transition's produced audio clip before actually skipping — because it
  called the exact same code path as the automatic cue-point handoff,
  which a comment defended as deliberate ("the two call sites can never
  disagree"). That comment was *true* and the behavior was still wrong —
  agreement between two code paths was never the actual requirement.
- A confirmed bug where dragging a scrub bar during fragment playback
  silently desynced the displayed time from the real audio, because the
  UI state was written unconditionally instead of only when the seek
  actually landed on real audio.
- A structural root cause (not a bug in either file alone) where the same
  transport-control logic was hand-copied into two components — the exact
  mechanism by which a fix to one silently fails to reach the other.
- A missing feature (a "go back" control that was asked for but never
  built) correctly left as an open design question rather than guessed
  at, because "resume where it left off" vs. "restart from the top" is a
  real product decision, not an implementation detail.
- An architectural limitation (no sample-accurate lookahead scheduling)
  named honestly as needing a real rewrite, with a contained, genuinely
  useful mitigation (buffer prefetching) shipped alongside it rather than
  either ignoring the deeper issue or attempting a silent full rewrite.

Read that doc for the level of specificity expected — concrete file:line
references, a stated severity, and an explicit status (fixed / open
question / architectural) per finding, not a vague "this could be better."

## When this is overkill

A cosmetic change, a copy edit, a one-line config tweak, or a change whose
correctness is genuinely obvious at a glance doesn't need this ceremony —
using it there just slows down easy work without buying anything. This is
for the cases where "looks right" and "is right" can actually come apart:
timing, ordering, shared mutable state, anything with more than one
trigger path to the same effect, anything where "it worked when I tried it
once" is doing a lot of unearned work.
