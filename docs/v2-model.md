# The v2 model — current state

Everything specified for v2 across the whole conversation, one place,
each piece marked with where it actually stands: **shipped**, **not
built**, or **needs a decision** before it can be built. This is a
snapshot, not a plan — see `TODO.md` for what's actually queued next.

## 1. Workflow philosophy — the point of v2

> "v2 changes how graphs are used. they aren't performed, they are just
> created. you drop in the songs you want, the transitions are detected
> and connected automatically, then you decide the intros and outros...
> this is better than just autoconnecting all the intros and outros
> because you get to see what is allowed to play after each song and
> don't just get a random tangle of links that amount to a shuffle."

Graphs stop being something you perform live from and become a pure
wiring/creation tool. Transitions auto-connect (they're unambiguous —
a produced transition asset always names its own two songs); intro/outro
deliberately stay manual, since a song might want to intro into one
destination and not another.

**Status: shipped.** Node autoconnect + full autoconnect (commit
`005ca13`) implement exactly this — Transition-only autoconnect, Intro/
Outro left manual, on purpose (see the code's own comments in `core.js`
for why None/Intro/Outro were deliberately excluded from autoconnect).

## 2. Multi-output — one song, several possible next songs

A song can carry multiple simultaneous Transition wires out; one is
picked at playback time.

**Status: shipped**, data model + selection. `node.transitions: [{edgeId,
targetId}]` (`core.js`), populated by `addTransitionConnection`/
autoconnect. Selection is currently uniform-random (`playlistNextHop`) —
see Weighting below for what replaces that.

## 3. Multi-input — one song reachable from several predecessors

Original ask: "a single socket can have multiple inputs."

**Status: already works, no changes needed.** The data model is
per-source: each predecessor's own node entry independently decides its
own wiring, so two different songs can already both target the same
destination today — verified via `disconnectAllWires`'s own multi-source
`.filter()` scan, which was written anticipating exactly this.

**Known gap (not fixed):** if two predecessors wire into the same
destination via *different* start types (one via Intro, one via
Transition), the destination's single `startMode`/`startEdgeId` field is
last-write-wins — a narrow, rare collision, not addressed.

**Known gap (not fixed):** no UI surfaces "multiple songs lead here" — you
only discover it by checking each source's own outputs individually.

## 4. Weighting

Rejected shape: per-input×output combo ("ridiculous" — most pairs don't
even link, so most of the matrix would be meaningless).

**Decided shape** (your words, final call over my own simpler
alternative — see note): "let each link get its own adjustable weight and
when one is updated, have the rest update to balance them all back to
100, but keep them proportional. setting it to random/even chance of
being picked by default is the right behaviour."

- Applies per same-type group (None links, Outro links, Transition links
  each weighted separately) — not across all types at once.
- Default: even chance, i.e. equal weights, until touched.

*Note: I'd proposed a simpler alternative this session — arbitrary
relative weight, no forced rebalancing, probability computed as
`weight / sum(all weights)` at selection time. You considered it and
explicitly chose the sum-to-100-with-proportional-rebalance version
instead. The spec above is your decision, not my suggestion.*

**Status: not built.** No weight field exists (`node.transitions` only
carries `{edgeId, targetId}`), no UI, selection is still `Math.random()`
uniform. Deliberately scoped out of this session's autoconnect work per
your own instruction ("implement everything up to and including
[autoconnect]... and then just think about how fit for purpose the rest
is").

## 5. Custom bundled socket

A socket bundling None+Outro (or all three: None/Outro/Transition)
together, so one drag from node A to node B's equivalent bundled socket
wires up every matching combination at once instead of dragging each
separately.

- Explicitly deferred: "kinda advanced for now though so don't start on
  it."
- When built: hidden in the detail pane (not on the node card itself);
  configuring one adds an entry to the output weightings.
- This session: "Your idea for the bundled socket is fine" — confirms the
  concept, does not schedule building it.

**Status: approved in concept only, not built, not scheduled.**

## 6. Visual requirement for multi-in/out wires

> "make sure multi inputs go into a single socket and multi outputs go
> out of one socket. alignment is key. If it looks like they're all
> overlapping at the end and like they're pointing at different things,
> no bueno."

Regardless of how many wires converge on or fan out of a node, they must
visually meet at one clean point — never read as scattered arrows aimed
at slightly different spots.

**Status: satisfied by construction in the socket design** (one socket
per type per side — multiple transitions already converge on the same
Transition socket) but **not verified against the actual multi-edge
rendering** — `GraphPane.jsx`'s `fannedBezierPath` is what physically
draws several simultaneous edges into/out of one handle, and that's the
part an alignment check would actually need to look at, not the socket
mockup.

## 7. Graph canvas interactions (this session)

- Rename **"Arrange for me" → "Autoarrange"**; favor a horizontal
  (left-to-right) layout, not vertical.
- Remove **"Delete song" from the right-click context menu** entirely.
- Selection box does **real multi-select** — every enclosed node
  individually selected, not just a bounding outline.
- Multi-select: `selectedId` effectively becomes the whole set, but the
  detail pane does **not** change to show anything for a multi-selection.
- Context menu **adapts to a multi-selection**: per-node "Autoconnect
  transitions" runs across every selected node; "Autoconnect all" stays
  whole-graph regardless of selection.

**Status: not built.** Logged in `TODO.md`.

## 8. Player model — combinatorial playback (this session)

The graph is assembled combinatorially at play time, not a fixed track
list. If A transitions into B: play A's own audio to the wired
transition's in-point, play the transition seamlessly, then seamlessly
resume B's own audio from the transition's out-point — never a hard cut
between "the graph" and "what's actually sounding."

| Piece | Status |
|---|---|
| Pause resumes exactly where it left off | **Already correct** in the shipped engine — `AudioContext.suspend()` genuinely freezes whatever's sounding, main deck or a fragment alike. Verified this session, not just assumed. |
| Skip just plays the next song normally, never forces a transition | **Fixed this session**, ahead of the full rewrite — `performAdvance({ forceCut: true })`. See `docs/playback-model.md`. |
| Back goes back to the previous song | **Not implemented at all.** No play-history log exists to go back *through*. Needs a decision first: does Back **resume** the previous song where it had gotten to, or **restart** it from 0? Not guessed at — see `docs/playback-model.md` Finding 4. |
| Starting from any node sounds identical to having played there from the true start | **Not built.** Genuinely a v2/multi-input-era question — once a song can have multiple predecessors, "the specific transition you'd have arrived via" is ambiguous, so there's no single canonical lead-in to replicate. A direct start is currently its own independent entry mode (Intro-or-cut from 0). |
| "Set Start" reconceived as a play-from-anywhere button | **Not built.** Still a wiring concept (a persistent graph connection), not a literal play button. |
| "Set End" reconceived as a stop button | **Not built.** Same gap, symmetrically. |
| The actual timing precision behind "seamless" | **Architectural gap, partially mitigated.** The engine reacts to a ~1-second polling tick and always starts audio "now," not at a precomputed exact time — the real cause of drift. A buffer-prefetch mitigation shipped this session removes the fetch/decode-latency part of the gap; the ~1s-or-worse scheduling slop itself needs a real scheduler, tracked in `TODO.md`. |

## What's explicitly *not* part of v2

- The socket **visual** redesign (shapes → circles, borders, dark mode,
  layout polish) is UI work for the *current* model — it doesn't change
  the data model or wiring rules above.
- Weighting's *shape* is decided (§4) but building it was explicitly
  deferred, independent of anything else here.
