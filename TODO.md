# Eskimo Studio — handoff notes

This file is the backlog and the reasoning behind it, for whoever (human or
agent) picks this up next in Claude Code.

**Push to `main`.** A `main` branch now exists, and Vercel deploys this
site straight from it (https://eskimo-freshstart17173-9037s-projects.vercel.app/)
— that's the live site the user actually looks at. Commit and push there
directly unless told otherwise; a change left on an unmerged `claude/*`
branch never reaches the user. See `CLAUDE.md`.

## Stack (changed this pass — read this first)

This used to be a single `index.html` with React/Babel loaded from a CDN
and no build step, by design. That stopped being the right tradeoff once
real pan/zoom, curved auto-routed edges, and auto-arrange were on the
table — those want a real graph library (`@xyflow/react`) and a layout
algorithm (`dagre`), neither of which ship a CDN-friendly global build. So
this is now a normal **Vite + React** project:

- `npm install` once, `npm run dev` to develop, `npm run build` to produce
  `dist/` (what `.github/workflows/pages.yml` deploys to GitHub Pages).
- `src/core.js` — data model, persistence (local + Supabase), pure logic.
- `src/audioDetect.js` — real audio matching (see below).
- `src/graphLayout.js` — the dagre auto-arrange wrapper.
- `src/components/` — one file per page/section.
- `src/config.js` — the three optional backend values (Supabase URL/key are
  already filled in against a live project; the upload worker URL is blank
  until you deploy it — see **Your tasks**).

## Positioning — read this before changing behavior

This is **not** live DJ software, not competing with Serato/rekordbox/
VirtualDJ. The person is a producer who builds elaborate mashups,
transitions, intros and outros in their own DAW — things that can't be
performed live, spontaneously — and this tool is where those pieces live
afterward: a "master graph" of songs and the pre-built audio connecting
them, so during a live set they can adapt in the moment while keeping the
benefit of studio-quality transitions built in advance. A big enough graph
means any song is a click away from anywhere else in it; enough closed
loops means the whole thing can auto-play as an infinite seamless set.

## Terminology glossary

Standard DJ words are kept as-is (Transition, Intro, Outro, BPM, Key, Cue).

**The Graph tab (PerformPage) now uses exactly two states — Active vs
Selected** (replaced Playing/Next/Later as of the node-redesign round
below; the old three-state model is gone from that screen entirely):

- **Active** — the song actually sounding right now (`session.nowPlayingId`).
  Only ever changes via a real playback action (Start, the detail pane's
  Play, a skip, or the wired hand-off), never as a side effect of clicking
  around the canvas.
- **Selected** — purely "what was last clicked" in the graph
  (`selectedId`, PerformPage.jsx) — decides what the right-side detail pane
  shows (inputs/outputs/specifics, plus the one Play button that can make
  it Active). Selecting never starts or changes playback by itself.

**LivePerformPage (the separate non-graph "Live" screen) has been removed
entirely** (player-rewrite round, see below) — dropped by direct
instruction rather than folded into the Active/Selected rework. There is
now exactly one perform screen (the Graph tab); nothing carries the older
Playing/Next/Later language anymore.

- **Cut** — a hard edge with no fragment. **Renamed to "None" everywhere** as of the graph-editor rework below (label and code both) — "cut" reads as a DJ term for something that isn't really a DJ move here, it's just "nothing built."

## Graph model — decided, don't revisit

Single node per song, directed edges between them. A remix is its own
song/node, not a sub-version. Loop-back edges get routed as curved arcs by
dagre automatically now (in Auto-arrange mode) — in Manual mode edges are
still React Flow's default smooth bezier, just following straight-line
node placement, since dagre isn't computing bends for a layout you're
controlling by hand.

## In progress — the graph becomes a playlist editor (replaces manual Next-list clicking as the primary way to plan ahead)

This is a large rework, spec'd out in detail with the user before writing
any code, because it touches the graph's core interaction model. Recorded
here in full so a fresh session (human or agent) can pick up mid-build
without re-deriving any of it. Read this whole section before touching
`GraphPane.jsx`/`GraphNodes.jsx`/`PerformPage.jsx`.

**The goal, in one sentence:** instead of clicking through the Sequence
pane's Next list one hop at a time, you build a playlist — even a closed
loop — directly on the graph by dragging connections between songs, and it
plays for real, live, the same way manual clicking always has. The two
aren't separate modes; there's no "build" screen vs. "play" screen. The
Sequence pane's Playing card / Next list stays as a manual fallback for
now — it isn't being removed yet, just no longer the primary way to plan
ahead. It only gets removed later, once this is proven to work flawlessly
and the two stay in sync (an explicit, separate future decision, not part
of this build).

### Data model

Two new pieces, alongside `songs`/`edges`/`session` in the persisted blob:

- **`session.activePlaylist`** — the live, always-editable wiring, edited
  directly on the graph regardless of whether anything's currently
  playing. Shape: a sparse map keyed by songId, since most songs in a
  large library won't participate in it at all:
  ```js
  activePlaylist: {
    id: null,              // set once saved; null = unsaved scratch wiring
    name: '',
    nodes: {
      [songId]: {
        startMode: 'none' | 'intro' | 'transition',
        startEdgeId: null | edgeId,   // which intro edge, when startMode is 'intro'
        endMode: 'none' | 'outro' | 'transition',
        endEdgeId: null | edgeId,     // which outro/transition edge, when endMode isn't 'none'
      }
    }
  }
  ```
  A song's *incoming* connection is never stored redundantly on that song
  — it's discovered by finding whichever other node's `endEdgeId` points
  at it (via the edge's own `l`/`r`). One direction of truth only.
- **`playlists`** — top-level array of saved snapshots, same shape as one
  `activePlaylist` plus its `id`/`name` filled in. "Save playlist" (a
  toolbar button) copies the current `activePlaylist` into a new entry
  here. Loading one replaces `activePlaylist` wholesale (a real replace,
  so it should confirm first — same "don't lose work silently" instinct
  as everything else destructive in this app).

**Critically, this does NOT replace `session.queue`/`nowPlayingId` or the
real audio engine — it feeds them.** When Now Playing has no manually
queued hop and its song has a wired `endMode` in `activePlaylist`, the
set-clock's tick (`App.jsx`) auto-commits that hop via the *same*
`commitTransition`/`commitCutOrOutro` functions a Next-list click already
calls — same session-queue entry shape, same `performAdvance`, same real
`audioEngine.js` playback. Autoplay's existing random-pick behavior only
still matters for songs that *aren't* wired — this graph wiring is meant
to make that random fallback increasingly unnecessary as more of the
library gets connected up. A closed loop (every song's output wired to
another's input, cycling back around) means the tick always finds a wired
hop, forever — that's what "you can walk away from it" means; nothing
about walking away is a separate mechanism from the ordinary tick loop
that already exists.

### Node anatomy: sockets, not a single hover-card

Each song node gets up to **six small sockets**, stacked on its left/right
edges — an input side and an output side, each with up to three typed
sockets. A socket only renders when it's actually possible for that song
(no outro produced → no Outro socket, full stop):

- **Left (input):** None · Intro · Transition
- **Right (output):** None · Outro · Transition

**Compatibility:** Transition only mates with Transition. The rest (None/
Intro on the left, None/Outro on the right) freely mix — Outro→Intro,
Outro→None, None→Intro, None→None are all valid.

**Click vs. drag on a socket does two different things** (this is exactly
what React Flow's `Handle` already distinguishes natively — pointerdown +
move-past-threshold is a drag, pointerdown + up in place is a click; nodes
already render `Handle` elements today, just invisible/inert
(`nodesConnectable={false}`), so this is turning on and styling something
already there, not fighting the library):
- **Click** a None/Intro/Outro socket → toggles it directly (no popup —
  it's a plain 2-state choice, and clicking again toggles back to None).
- **Drag** from a Transition output socket to another node's Transition
  input socket → wires a real produced transition. If more than one
  produced transition exists between that pair, a small searchable list
  pops up at the drop point (same drain-bar-countdown list design as the
  old Next list) to pick which one — search matters here since a song can
  have many built transitions. If none exists between that pair, the drag
  just snaps back — dragging *selects* a produced transition, it never
  fabricates one.
- Dragging a **new** connection onto a socket that already has something
  wired silently replaces it (no confirm, no rejection) — same instinct as
  Blender letting a new cable bump the old one off a socket.
- **Reopening an already-wired Transition's label** (see below) shows that
  same searchable list, scoped to this song's *other* transition
  candidates. Reopening a wired None/Outro/Intro just re-toggles directly
  — no list, nothing to search, only two states exist.

**v1 restricts each socket to at most one active connection.** Dragging a
second wire out of an already-wired output replaces the first rather than
adding a parallel path. Multiple simultaneous outputs (real branching,
autoplay actually choosing between live options) is explicitly a later
feature this data model shouldn't preclude, but v1 doesn't build it.

**Disconnecting a wire:** hovering an active wire reveals a small "✕"
badge at its midpoint — you must hit that small target specifically.
Clicking the bare wire path itself does *nothing*. (Originally proposed as
"click the wire to remove it" and correctly rejected as a real hazard — a
stray click destroying part of a built playlist is exactly the kind of
accident this app has been deliberately designed against everywhere else:
End Set, deletes with undo toasts, the red-button treatment. Same
instinct applies here.)

**The label on a connected socket:** once wired, the node grows slightly
to show a small label near that socket — the transition's name, or
"Outro"/"Intro". Clicking it reopens the picker per the rule above.

### Three distinct arrow states — not two

- **Grey dotted** — a produced transition exists between this pair but
  isn't wired into the current playlist. Drawn for *every* produced
  transition edge, always, unconditionally — this replaces today's
  tiered next/later/base accent-colored edges entirely. Thin, sparse dash,
  not interactive itself (you never grab an existing grey line — you
  always drag a fresh connection between sockets; if a produced edge
  matches, its grey line is the one that lights up).
- **Black dotted** — an *active* non-transition sequence link (any of
  Outro→Intro, Outro→None, None→Intro, None→None). Shows "these two play
  back to back" without implying a produced crossfade exists. Tighter
  dash, slightly thicker than the grey one.
- **Black solid** — an active *transition* connection. Thickest, solid.
  Animates (marching-ants dash, same mechanism the old "next" tier edge
  already used) specifically during the real crossfade window — tied to
  the actual `audioEngine.js` elapsed time, the same window
  `mixingIntoSong`/`CROSSFADE_LOOKAHEAD_SEC` already compute today, not
  just "this is queued next."

All three need an arrowhead (direction has to read at a glance) and need
to stay visually distinct at a zoomed-out scale — dash rhythm and stroke
weight carry the difference, not color alone, since color's off the table
here (next point).

**No per-song or per-cover color anywhere in this system.** Actively
considered and rejected: extracting a dominant color from cover art for
the active wire and for "one hop away" nodes doesn't read cleanly (an
all-black or muddy cover breaks the whole mental model). Active
connections are just solid `--ink` (flips correctly with the theme, same
as the rest of the app's flat design). "One hop away" candidates get a
plain muted/lower-opacity treatment instead of their own hue.
**`--accent` (the blue) is removed, but only inside Perform/graph-scoped
CSS** — the rest of the app (search focus ring, other pages) keeps it.

### Zoom level-of-detail

Below a fixed zoom threshold, node cards drop to a simplified rendering —
just cover art, song name, and (if it's the one actually sounding) the
Now Playing highlight, plus the arrows between nodes. Tags, sockets, and
labels disappear entirely rather than fading; a hard cutoff, not a
continuous fade (confirmed — simpler, predictable, matches how most node
editors including Blender do it). Read the current zoom via React Flow's
viewport/zoom hook, not CSS media queries (it's the canvas's own zoom, not
the browser's).

### Visible countdown timers, not just numbers

Every transition and outro anywhere in this system — sockets, their
reopened candidate lists, the readonly filmstrip below — shows a real
progress bar counting down to its cue point, not just a number. This
already exists in one place (the old Next list's drain bar); it needs to
exist everywhere a transition/outro is shown, computed off the same real
per-edge cue math (`outSeconds` vs. actual elapsed time) already in
`nextRows`, not a new metric.

### The bottom bar: readonly filmstrip, not an editable queue

The `QueueBar` component and `session.queue`'s manual add/remove UI go
away as a user-facing editing surface. In its place: a readonly strip
*derived* from `activePlaylist` — starting at Now Playing, walk forward
through whatever's actively wired, show that chain of chips. Since it's
derived rather than independently maintained, it can never drift out of
sync with the graph. Clicking a chip calls the existing `focusOn(id)` to
pan/zoom the graph there — it's a navigation aid, not an editor.

### Build order for this pass

1. [x] ~~**Data model**~~ — done: `session.activePlaylist` (the live,
   always-editable wiring — `{ id, name, nodes: { [songId]: { startMode,
   startEdgeId, endMode, endEdgeId, nextSongId } } }`) and top-level
   `playlists` (saved snapshots of the same shape) added to `core.js`,
   persisted locally + pushed remotely, round-tripped through the backup
   download/restore file, and cleaned up on song deletion
   (`removeSongFromPlaylist`, applied to both the live wiring and every
   saved playlist so a deleted song can never leave a dangling reference).
   Pure helpers added: `emptyActivePlaylist`, `wireConnection`,
   `unwireOutput`, `playlistNextHop`, and the socket-eligibility helpers
   (`introEdgeFor`/`outroEdgeFor`/`transitionEdgesTo`/
   `transitionEdgesBetween`/`leftSocketTypes`/`rightSocketTypes`).
1b. [x] ~~**Wire it into real playback**~~ — done ahead of the graph UI
   that will actually let you build wiring, because it's the part that's
   easy to get subtly wrong and everything else is easier to verify once
   it's solid: `audioEngine.js`'s `performAdvance` now falls back to
   `playlistNextHop(activePlaylist, nowPlayingId)` whenever nothing's
   manually queued, *before* autoplay's random pick — using the exact
   same session-entry shape (`{id, mode:'transition', edgeId}` /
   `{id, mode:'cut', ending, starting}`) a manual Next-list click already
   produces, so `advanceSession`, the real `audioEngine.js` handoff, and
   the Sequence pane all keep working completely unchanged. Also fixed a
   real bug caught in the first verification pass: `App.jsx`'s tick
   computed its cue-point trigger from `queue[0]` only, so a wired-but-
   unqueued hop would silently wait for the full song length instead of
   its transition's actual built cue point — now computed from
   `queue[0] || playlistNextHop(...)`, the same "effective head" both the
   trigger check and the handoff use.
   Verified in a real browser: a two-song wired transition hands off at
   its real cue point (not the full song length) with nothing manually
   queued and autoplay off; a three-song closed loop (transition → a
   plain wired None hop with no produced edge at all → transition closing
   back to the first song) cycles indefinitely — confirmed over multiple
   hops — with zero manual clicks and zero reliance on autoplay's
   randomness, which is the entire point ("you can walk away from it").
2. [x] ~~**Graph visuals**~~ — done: the old tiered next/later/base edge
   coloring is gone, replaced by the three-state model in `GraphPane.jsx`
   — every produced transition renders as a thin grey dotted arrow always
   (`transitionEdgesRaw`, unconditional); the one actually active in
   `activePlaylist` (matched by `endEdgeId`) renders instead as a thick
   solid ink arrow, and animates (marching-ants) only while
   `mixingEdgeId` says a real crossfade is in progress; active non-
   transition links (Outro/None/Intro/None pairings with no produced edge
   behind them) are synthesized straight from `activePlaylist.nodes` as a
   separate ink-dotted family. `GraphNodes.jsx`'s old single hover-card
   (Transition/Cut/Outro buttons) is gone, replaced by up to six typed
   `Handle`s per node — None/Intro/Transition on the left, None/Outro/
   Transition on the right, each hidden entirely when `leftSocketTypes`/
   `rightSocketTypes` (`core.js`) say that type has zero eligible options
   for that song.
   Superseded within this same pass: the first cut coded socket type via a
   monochrome letter (N/I/O/T) on the theory that a new color system would
   fight the app's ink/paper brutalist style. Feedback after seeing it next
   to a real Blender screenshot was that it "doesn't look that great" and
   asked directly for the Blender pattern instead — real text labels in
   normal document flow (not floating dots) and a small **fixed color per
   socket *type*** (None=grey, Intro=teal `#3f9e82`, Outro=amber `#c98a3e`,
   Transition=violet `#8b6fc9`, via `--socket-border`/`--socket-ring` CSS
   custom properties on `.node-socket-<type>`). This is a different thing
   from the per-*song* cover-art coloring rejected earlier in this same
   spec (that varied by song and couldn't be trusted to read cleanly
   against arbitrary art) — a small four-color legend that's identical on
   every node is exactly what makes a real node editor scannable at a
   glance. `GraphNodes.jsx`'s `SocketRow`/`SocketList` do the layout; a row
   nests its `Handle` inside its own `position: relative` div so CSS
   resolves the handle's absolute position against *that row*, not the
   whole card — ordinary flexbox column stacking then just works for
   however many rows a song has.
   A second round of feedback, after drag-to-connect (item 3 below) landed
   and multi-candidate transitions/outros started actually appearing:
   *"seems like the transitions are getting their own named sockets. Don't
   want that, i want a dedicated transition socket and a dropdown... this
   pattern can then repeat for intros and outros."* The label had been
   renaming itself to whichever specific edge was wired ("Fast cut" instead
   of "Transition") — reverted so the row label is always just the fixed
   type name, and a small inline `<select>` (`.node-socket-select`, class
   `nodrag` so it doesn't start a node-drag) appears next to it whenever
   2+ candidates exist for that active slot — `introEdgesFor`/
   `outroEdgesFor` (`core.js`, plural — a song can have more than one
   intro/outro fragment now, not just one) plus the existing
   `transitionEdgesBetween` feed `socketDataById`'s `leftOptions`/
   `rightOptions` in `PerformPage.jsx`; picking a different option calls
   `setStartVariant`/`setEndVariant` (`core.js`) via `selectVariant`, which
   swaps only the specific `edgeId` — endMode/startMode/nextSongId (i.e.
   which song it's wired to) never change from a dropdown pick. This also
   deleted the old drag → multi-candidate-modal picker entirely: dropping a
   Transition connection with several candidates now just auto-wires the
   first one and leaves the dropdown to switch it, matching the same "no
   second popup to drive through" instinct.
2b. [x] ~~**Socket interaction (None/Intro/Outro)**~~ — done ahead of
   drag-to-connect: clicking a None/Intro/Outro socket toggles it
   directly (clicking the already-active one turns it back to None) via
   `PerformPage.jsx`'s `toggleSocket`, which writes straight into
   `session.activePlaylist` — Intro/Outro each resolve their own
   `startEdgeId`/`endEdgeId` from the one produced intro/outro edge for
   that song. Verified in a real browser: clicking Intro sets it and
   toggling again clears it back to none; clicking Outro sets
   `endMode:'outro'` with the right `endEdgeId`. One real testing
   footgun worth recording: Playwright's synthetic `.click()` doesn't
   reliably fire on a React Flow *source*-type `Handle` (it silently did
   nothing in the first pass) even though a native DOM `.click()` on the
   exact same element works correctly — confirmed this is a Playwright/
   React-Flow interaction quirk, not a real bug, before moving on;
   future tests against source-side sockets should dispatch via
   `element.click()` in `page.evaluate` rather than Playwright's own
   `.click()`.
3. [x] ~~**Drag-to-connect**~~ — `nodesConnectable` is `true`; every socket
   (not just Transition) is a real drag-connectable `Handle` now, since
   None/Outro on one song linking to None/Intro on a *different* song is
   itself only expressible by a drag (a plain click on one song's socket
   has no way to say which other song it should point at) — None/Intro/
   Outro additionally still toggle on a plain click for the no-particular-
   partner case ("this song just ends with an outro"). `isValidConnection`
   (`PerformPage.jsx`) enforces Transition-only-meets-Transition and
   otherwise allows any None/Outro → None/Intro combination.
   `handleConnect` resolves a Transition drop to the first produced
   candidate between that pair (or the outro/intro edge for a non-
   transition drop) via `commitWire`/`wireConnection` — see item 2 above
   for the dropdown that switches away from that first pick. Disconnecting
   is the hover-✕ (`ActiveEdge` in `GraphPane.jsx`, via `EdgeLabelRenderer`)
   on the wire's midpoint, never the wire itself — calls `onDisconnectSong`
   → `unwireOutput`. Verified end to end in a real browser: a two-
   candidate Transition drag auto-wires the first and the row's dropdown
   switches to the second; a two-candidate Outro drag likewise; an invalid
   Transition→None drag is rejected and leaves state untouched; the
   hover-✕ disconnects without needing a click on the line itself.
   Two real bugs found and fixed along the way, both worth remembering:
   (a) sockets other than Transition had `isConnectable={type ===
   'transition'}`, which silently made the None/Outro/Intro drag path
   above unreachable — fixed by making every socket connectable and
   leaving the type-pairing rule to `isValidConnection` instead of to
   which sockets can even start a drag. (b) React Flow's own
   `fitViewOptions`/`defaultEdgeOptions`/`proOptions` were inline object
   literals in JSX, so every render created new ones; since `GraphPane`
   re-renders once a second while a set plays (the elapsed clock), React
   Flow was reacting to those identities changing by re-syncing internal
   state, which very briefly dropped every edge's rendered position to
   null — invisible for the line itself, but enough to unmount and remount
   the hover-✕ button living in each active edge's `EdgeLabelRenderer`
   portal, a real flicker on every live set. Hoisted to module-level
   constants (same fix applied to node `style` objects, and the ticking
   elapsed clock was moved off React Flow's node `data` entirely onto a
   `NowPlayingContext` in `GraphNodes.jsx` so the once-a-second tick never
   calls `setNodes` at all) fixed the sustained version of this outright;
   what's left is a rare single-frame blip that only shows up at a
   non-default zoom level shortly after a manual wheel-zoom, not on a
   freshly-loaded or already-settled view — investigated at length (traced
   through React Flow's `EdgeWrapper`/`getEdgePosition` internals) without
   finding a further first-party cause, so it's logged here rather than
   chased further; if it turns out to matter in practice, the next place
   to look is whatever `ResizeObserver`-driven remeasurement React Flow
   itself runs on zoom.
4. [x] ~~**Countdown ring on Transition/Outro sockets**~~ — not a linear
   bar: `CountdownRing` (`GraphNodes.jsx`) is a small fixed-size SVG ring
   next to the active row, stroke color sweeping a single HSL hue from
   green (120°) to red (0°) — passing through yellow/orange on its own,
   no separate named thresholds — as the cue approaches inside a fixed
   20s warning window (`RING_WARN_WINDOW_SEC`); full green (and simply not
   rendered before that) the rest of the time, so it reads as "plenty of
   time" until it actually needs attention. Only ever shown for the song
   actually playing (`rightCueSeconds` from `socketDataById`, matched
   against the live elapsed clock via `NowPlayingContext` — see item 3's
   bug (b) for why that's a context and not node `data`). Outro and
   Transition both read it off `endEdgeId`'s `outSeconds`, so both get a
   real "is there still time" signal, not just a number.
4b. [x] ~~**A full UI pass on the socket redesign**~~, after seeing items 2-4
   land: every socket now shows a **fixed three-row layout, always** —
   None/Intro/Transition on the left, None/Outro/Transition on the right,
   in that order, on every song, whether or not this particular song can
   use a given row. `LEFT_SOCKET_TYPES`/`RIGHT_SOCKET_TYPES` (`core.js`)
   replace the old `leftSocketTypes`/`rightSocketTypes` (which returned
   only the eligible ones, giving each song a different row count); the
   new `leftSocketAvailability`/`rightSocketAvailability` say which of the
   fixed three are real for this song. An unavailable row still renders —
   grey dot, dim label, `isConnectable={false}`, no click handler — rather
   than disappearing, so every card scans the same shape. Available dots
   (active or not) all render identically now too: solid, filled with the
   type's color, straddling the card edge at the same `-14px` offset every
   row uses — the earlier pass had active dots solid-filled and merely-
   available ones hollow-outlined, which read as two different socket
   *styles* rather than one style plus a selection state; the active one
   now gets a ring/glow (`box-shadow`) on top of the same fill instead.
   Measured directly (not just eyeballed) and confirmed the LEFT-side dots
   sit centered on the card's actual border to well under a pixel — but
   raised again immediately after, specifically about the RIGHT side, and
   that report was correct: two real bugs, not one.
   (a) `.node-socket-side-right` set `align-items: flex-end` so a right
   row would shrink-wrap to its label's width and align to the column's
   end, rather than stretching full-width the way left rows do by default
   — and since the socket dot is `position: absolute` (out of flow, taking
   no part in that sizing at all), a shrink-wrapped row's own edge simply
   didn't land on the card's actual border anymore. Fixed by dropping that
   override so both sides stretch identically.
   (b) A second, deeper bug this exposed: `.node-socket-row .node-socket
   { left: -14px }` and `.node-socket-row-right .node-socket { right:
   -14px }` are two different CSS properties, so the second rule was never
   "overriding" the first just for being more specific to the right-side
   case — **both** applied at once, and per the absolute-positioning spec,
   a fixed (non-`auto`) width means `left` wins outright and `right` is
   silently discarded. Every right-side socket on every song, and Start
   Set's one (source, right-side) socket, had actually been positioned via
   the LEFT rule the entire time — nowhere near the card's real edge, which
   is exactly why an arrow into a right-side socket looked like it was
   landing in empty space, and why Start Set's socket looked like it was
   sitting on the wrong side entirely (its "wrong side" was never really a
   left/right logic bug in `StartNode` itself — `Position.Right` and the
   `-right` row class were already correct there; the CSS underneath them
   was silently ignoring `right` everywhere). Fixed with an explicit
   `left: auto` on the right-side rule so `right` actually takes effect.
   Confirmed by direct measurement afterward: dot-to-border distance is
   sub-pixel on both sides now, not just the left.
   **A real bug, and the highest-priority one reported this pass**: with
   three stacked handles now always present per side (all sharing the same
   React Flow `Position.Left`/`Position.Right`, distinguished only by
   `id`), `rfEdges` (`GraphPane.jsx`) had never set `sourceHandle`/
   `targetHandle` on any edge — so React Flow had no way to know which of
   the three a given arrow should anchor to, and every arrow visually
   landed on the first (None) row regardless of which socket was actually
   wired. Every edge builder now sets both explicitly (transitions always
   `right-transition`/`left-transition`; the synthesized non-transition
   links use the source's real `endMode` and the destination's real
   `startMode`). This was a latent bug from the very first socket pass —
   it only became glaringly visible once every song showed all three rows
   at once instead of just whichever one was active.
   The dropdown (item 2) is no longer a native `<select>` — a custom
   listbox (`SocketDropdown` in `GraphNodes.jsx`) so the still-*closed*
   candidates can carry their own live countdown ring too (a native
   `<option>` can only ever be plain text), which was the actual point of
   moving the ring near the dropdown in the first place: opening it shows
   which of the wired song's produced options is soonest, not just the one
   currently selected. Click-outside-to-close via a plain `mousedown`
   listener while open. The ring itself also shrank by half and moved to
   sit directly after the row's label (not past the dropdown).
   The hover-✕ disconnect button is no longer permanently visible — a
   `HoveredEdgeContext` (`GraphPane.jsx`) tracks which edge id the pointer
   is over via React Flow's own `onEdgeMouseEnter`/`onEdgeMouseLeave`, kept
   out of `rfEdges`' own memo so hovering doesn't force every edge object
   to recompute. The button also claims "hovered" on its own
   `onMouseEnter` (it lives in a separate `EdgeLabelRenderer` DOM subtree
   from the edge path, so crossing the small gap between line and button
   would otherwise flicker it closed right as you reach for it).
   Snap feedback while dragging a connection: React Flow already marks the
   closest compatible handle within `connectionRadius` with real `valid`/
   `connectingto` classes — there was just no CSS reacting to them, so a
   drag landing near a real target looked identical to one landing in
   empty space. `connectionRadius` raised to 32 (from the default 20) and
   `.connectingto.valid` now scales the handle 1.5x with a ring glow.
   Added a **Start Set** node (`StartNode`, `GraphNodes.jsx`) — the graph
   had an End Set bookend but no symmetric entry point. It's purely
   informational like End Set (an intro edge ranks a song against it in
   `computeDagreLayout` the same way an outro edge ranks one against END);
   unlike End Set, nothing ever gets "queued" at Start — a set can begin
   from any song, so there's no equivalent operational meaning to invent,
   just a hint reflecting whether one has already started.
5. [ ] **Save/Load playlist** — toolbar button, persisted `playlists`
   array, confirm-before-replace on load.
6. [ ] **Readonly filmstrip** replacing `QueueBar`.
7. [ ] **Zoom level-of-detail.**
8. Only after all of the above is solid: revisit whether the Sequence
   pane's Playing card / Next list can be retired, as its own explicit
   decision — not assumed here.

## Done this pass (round 2 — polish, autoplay, real cue timing)

- **Verification is gone as a separate step.** You listen to the dropped
  file (a real `<audio>` preview) on Add Audio before saving — there's no
  more "unverified" edge sitting in Library waiting for a later verify
  click, and no more unlabeled dot to be confused by. Library rows for a
  built edge now offer an audio preview player too (when audio storage is
  configured), not a verify button.
- **Real per-edge cue timing.** Add Audio now persists the detected (or
  placeholder) in/out points onto the edge itself (`outSeconds`/
  `inSeconds`) instead of only displaying them. The Next list's countdown
  is no longer one shared clock — each transition candidate counts down
  its *own* cue point against Now Playing's actual elapsed time, floats to
  the top while time remains (soonest-expiring first), and candidates
  reachable only by a cut (which never expires) sink below them.
- **Autoplay + transition-only mode + a real bottom queue bar.** Turning
  on Autoplay picks randomly among built transitions when nothing's
  queued, falling back to a random cut elsewhere in the library to keep an
  "infinite playlist" going; Transition-only instead ends the set at a
  dead end, guaranteeing every hop stays seamless. The queue bar (back
  from an earlier pass, now genuinely useful) shows the whole run —
  history, Playing, and what's committed — and auto-scrolls to keep up.
  Library also gained multi-select: check a run of rows in the order you
  want them and queue the whole thing in one action instead of staging
  one at a time.
- **"How long can this graph play seamlessly?"** — researched, not
  guessed: the longest-simple-path problem is NP-hard and counting
  distinct orderings is #P-complete (see `src/graphEstimate.js`'s header
  comment for the sources), so there's no exact answer to compute. What's
  implemented instead is exact and polynomial: Tarjan's SCC algorithm
  finds closed loops (which make infinite transition-only play possible at
  all), then a longest-path DP over the resulting condensation DAG gives
  an honest upper-bound estimate of how many distinct songs one run could
  reach. Shown live in the Sequence pane.
- **Visual pass**: accent color swapped to a light pastel blue; node
  card text alignment fixed (tags/io row was bottom-aligning mismatched
  element heights, now centered); a dot-grid background on the canvas;
  mutually-exclusive choices (Cut/Outro, Transition/Cut, Cut/Intro) now
  render as a single joined segmented control instead of separate buttons,
  so exclusivity reads as a property of the layout, not something you
  infer; disabled options in a segmented control show struck-through
  rather than just faded; the Playing node grows slightly and gets a small
  animated waveform instead of only a pulsing border; every node is always
  draggable now, in both layout modes; hover states got a subtle lift
  (shadow + scale) across nodes and toggles; arrowheads shrunk across the
  board and the old separate thick-black "committed path" overlay is gone
  — the actual next-tier edge just animates (marching-ants dash) instead.

## Done this pass (round 1 — stack + backend)

**Stack**: moved off single-file/Babel-in-browser to Vite; adopted
`@xyflow/react` for the graph canvas (real pan/zoom, wheel-zoom-to-cursor,
drag-to-pan, smooth bezier edges, draggable nodes) and `dagre` for an
"Arrange for me" auto-layout toggle that coexists with manual dragging.

**Graph readability**: no more badge-circle for queue position — nodes get
exactly one of three highlight treatments (outline + tint, not a black
fill) for Playing/Next/Later. Small album-art placeholder on every card
(swap for a real cover thumbnail whenever the library stores one). In/out
counts are bare `↓N ↑M` numbers, fixed position, no words.

**Search**: real fuzzy search (Fuse.js) over title+artist, an autocomplete
suggestion list while typing, prev/next chevrons with a count to step
through matches, non-matches dimmed on canvas, and each step pans/zooms
(via React Flow's `setCenter`) to the result. "Focus active" button does
the same for whatever's Playing (or fits the whole graph if nothing is).

**Sequence pane**: no more standalone "End Set" button — ending a set
happens by staging the graph's End Set node like any other Next/Later
pick (still explicit and plannable, just not a giant always-present call
to action), or simply by not queueing anything and letting the song run
out (the set clock now actually ends the set when time runs out with
nothing armed, instead of silently looping the countdown). Added a
persistent, always-visible "How it ends: Cut / Outro" toggle on the
Playing card — independent of whatever's staged in Next — which is where
the previously-missing "start the outro" control lives.

**Real audio detection + reference tracks** (`src/audioDetect.js`): Add
Audio no longer only fakes a match. Every uploaded song can be downloaded
from Library as its exact reference master; because a transition/intro/
outro gets built from that same file, the dropped file's waveform is
(near-)identical to the reference at the splice point. Detection decodes
both with the Web Audio API, reduces each to a coarse RMS energy
envelope, and finds the best-aligned normalized cross-correlation between
the dropped file's head/tail and every reference track's tail/head — real
signal processing, not a hash-based mock, and the winning correlation lag
converts directly into the actual detected in/out timecodes (no longer
`pseudoCuePoints`-guessed) shown on the waveform markers. Falls back to
the old deterministic placeholder matcher only when there's no reference
audio anywhere yet to correlate against (and says so in the UI).

## Your tasks — step by step, to get this fully working (only you can do these)

The app already **works right now with zero setup**: everything runs
locally in `localStorage`, no account or config needed, and every feature
in this file (including real audio analysis and real playback) works the
moment you upload real audio files — none of the steps below are required
just to use the app on one browser/one device. What they unlock:

- **Step 1 (GitHub Pages)** — a public URL, so it's not just `localhost`.
- **Step 2 (Supabase)** — your library syncs across your own devices/browsers.
- **Step 3 (Cloudflare R2 + the worker)** — uploaded audio is actually
  stored somewhere real (not just on the one browser you dropped it in),
  which is also what turns on real audio detection in Add Audio and real
  BPM/key/duration analysis and real playback in Upload Song / Perform for
  everyone who opens your synced library, not just you, locally.

None of the three steps depend on each other — do them in any order, or
skip whichever you don't need. Current status of each, as of this pass:

### 1. GitHub Pages — get a public URL
**Update: superseded — the real deploy is Vercel, from `main` (see the
top of this file), which now exists and is what's actually live at
https://eskimo-freshstart17173-9037s-projects.vercel.app/. Everything
below is the old GitHub-Pages-specific investigation, kept for history;
Pages may still be broken exactly as described (unconfirmed since), but
it's no longer the thing serving the actual site.**

**Status (as of that investigation): confirmed broken, two separate causes, both need a human.**
Checked via the GitHub MCP connection: `pages.yml` has run 29 times, every
one triggered by a push, every one `conclusion: failure` — but
`list_workflow_jobs` on the most recent run shows **zero jobs ever ran**,
and its log URL 404s. Zero jobs plus an instant failure is what it looks
like when a run is rejected at the `environment: github-pages` gate before
any step executes — i.e. **GitHub Pages has never actually been enabled**
for this repo. Separately, `pages.yml` triggers `on: push: branches:
[main]`, but **this repository has no branch named `main`** — every commit
so far lives on `claude/codebase-onboarding-tasks-ng8pny` or the default
branch `claude/eskimo-ui-mockup-uxdg8z`. Either alone would keep the site
from ever deploying; both are true at once here. Neither is fixable from
this session — enabling Pages and choosing/renaming a default branch are
both repo-Settings actions with no equivalent exposed through the GitHub
MCP tools available here.
1. **Enable Pages**: repo → **Settings → Pages → Build and deployment →
   Source → "GitHub Actions"**. If that page has never been touched,
   Source is likely unset — this is step one, not optional.
2. **Give the workflow a branch that exists**: either (a) rename
   `.github/workflows/pages.yml`'s trigger to the branch you actually want
   to deploy from (simplest: change `[main]` to the current default
   branch's name), or (b) create a real `main` branch from whichever branch
   has the code you want live and merge into it going forward, matching
   what the workflow already expects. Once both of these are true, the
   next push (or a manual "Run workflow" from the Actions tab — the
   workflow already has `workflow_dispatch` enabled) should actually
   execute and deploy `dist/`.
3. The workflow's Actions run will show the live URL once it finishes
   (also visible under Settings → Pages afterward).

### 2. Supabase — sync your library across devices
**Status: mostly done — one toggle left.** A Supabase project named
"eskimo" is already live and wired up: `supabase/schema.sql` (one
RLS-scoped `library` table) is applied, and `src/config.js` already has
that project's real URL and anon publishable key — nothing to create or
copy here.

Checked again this pass via the Supabase MCP connection (project
`knkboafsybgifsulxknz`, the one `src/config.js` actually points at — there's
a second, older, unused project named "Eski" on the same account, not this
one): schema and RLS are correct (`library` keyed by `user_id`, scoped to
`auth.uid()` on select/insert/update), and both advisor findings that
existed were fixed directly — a `rls_auto_enable()` housekeeping event-
trigger function was publicly callable via PostgREST RPC (revoked
`EXECUTE` from `anon`/`authenticated`; the trigger itself doesn't need it
to fire) and the three `library` RLS policies were re-evaluating
`auth.uid()` per row (rewritten as `(select auth.uid())`, the initplan
pattern Postgres/Supabase's own linter recommends). `get_advisors` reports
clean on both security and performance now. I could *not* verify the
actual toggle below end-to-end: this sandbox's headless browser can't
reach any external host at all (confirmed directly — a plain `fetch()` to
Supabase's own `/auth/v1/settings` from inside the page returns
`ERR_CONNECTION_RESET`, same as a request to Google Fonts), and the
Supabase MCP tools available here don't expose Auth provider settings
(only schema/SQL/advisors/edge-functions/branches) — so this one step
still needs a human with dashboard access.
1. Open the **eskimo** project at supabase.com/dashboard.
2. Go to **Authentication → Providers**.
3. Enable **Anonymous Sign-Ins** (there's no login screen in this app —
   anonymous auth is what gives each browser a stable identity to sync
   under).
4. That's it — no further config. Sync silently does nothing (fails quiet,
   logs a console warning) until this one toggle is on; every session run
   in this pass still shows that same warning, so this is very likely
   still off.

### 3. Cloudflare R2 + the upload worker — real audio storage
**Status: not started.** `UPLOAD_WORKER_URL` in `src/config.js` is still
blank and `worker/wrangler.toml`'s `PUBLIC_BUCKET_URL` is still the
placeholder — until this step is done, uploaded audio only ever becomes a
local-to-your-browser file (metadata is saved, but there's no real
`audioUrl`, so Add Audio detection, BPM/key/duration analysis, and real
playback all silently fall back to their no-audio behavior for anyone else
who opens the synced library).
1. **Create the bucket** (needs a free Cloudflare account + `wrangler`,
   installed automatically by `npx`):
   ```
   npx wrangler login
   npx wrangler r2 bucket create eskimo-studio-audio
   ```
   (the name already matches `worker/wrangler.toml` — no edit needed for
   the bucket name itself).
2. **Turn on public access**: Cloudflare dashboard → R2 → your bucket →
   Settings → **Public access** → enable it (the free `r2.dev` subdomain
   is fine to start; a custom domain works too). Copy that public URL.
3. **Paste that URL into `worker/wrangler.toml`**, replacing the
   `PUBLIC_BUCKET_URL` placeholder under `[vars]`.
4. **Add CORS to the bucket itself** (a separate concern from the worker's
   own CORS below — this is what lets the browser `fetch()` reference
   audio directly from R2 for detection/analysis/playback and the download
   button). Bucket → Settings → **CORS Policy** → add:
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   (Tighten `AllowedOrigins` to your actual `https://<you>.github.io` once
   step 1 gives you that URL — `"*"` is fine to get started.)
5. **Deploy the worker** (this is what the app's Upload Song / Add Audio
   pages actually POST files to — it already sets its own CORS headers for
   its `/upload` endpoint, so there's nothing to add there beyond step 4):
   ```
   cd worker
   npx wrangler deploy
   ```
   This prints a `*.workers.dev` URL — copy it.
6. **Paste that worker URL into `src/config.js`'s `UPLOAD_WORKER_URL`**
   (or set it as a `UPLOAD_WORKER_URL` repo secret instead — the Pages
   workflow already knows to read `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
   `UPLOAD_WORKER_URL` secrets and patch them into the build at deploy
   time, so you don't have to commit the worker URL directly if you'd
   rather not).
7. Commit/push (if you edited `src/config.js` directly rather than using a
   secret) — the next Pages deploy will pick it up.

### 4. When you're done
Tell me which of the three you completed (or which you'd rather I do
myself where I can — I can apply Supabase schema changes and read config
through the MCP connection, but I can't click the Pages/Auth toggles or
hold your Cloudflare login for you). Once any of these are live I'll
verify that piece end-to-end against the real thing — sync, upload,
detection, analysis, playback — rather than only against the local build
the way everything's been verified so far.

## My tasks — Easy / Medium / Hard

Everything below came out of actually looking at this with an eye toward
"would this read as sleek, minimalist, and obvious to someone who's never
seen it" — the standard you asked for, benchmarked against the kind of
apps this one takes inspiration from.

### Done this pass (round 6 — a real non-graph Live screen, outro/short-overlap detection fixes)
The graph is disabled (greyed out in the sidebar, `disabled`, tooltip
explaining why — still fully intact in code, just unreachable) in favor of
a brand-new **Live** screen (`LivePerformPage.jsx`), now the app's default
tab: four columns, left to right — Playing, How it ends, Next song starts
via, Next song — each a flat list of cards, nothing gated behind the old
3-way mode toggle first (every produced Transition off the playing song is
its own card in "How it ends", right alongside None/Outro). Playing's card
gets a left-to-right elapsed progress bar; every other card gets a
right-to-left countdown (a transition counts down to its own real cue
point same as the graph's Next list always did; None/Outro/start-mode
cards all share the playing song's own remaining time, since none of them
have an earlier expiry of their own). The whole column set plays a brief
slide-in whenever the playing song actually changes. Deliberately its own
component rather than a second render path inside `PerformPage.jsx` — it
only touches `session.queue` through the same core.js/audioEngine.js
functions the graph already used (so the two can never disagree about what
a hop does), but the interaction glue (commit/start/end/stop) is a fresh,
independent copy — worth remembering if the graph ever comes back, since a
fix to one won't automatically reach the other.

Also this pass: **tested the outro fix directly** (dev server; the live
Vercel deployment is behind Vercel's own SSO/deployment-protection wall,
so it couldn't be reached directly from here — ask the user to confirm on
their end, or open deployment protection to test it live). Wiring an early
forced cue point and watching the real session clock confirmed the hop
now fires well before the song's recorded duration, for both a wired
ending and a manual "End set → Outro" — matches the fix described above.

Found a real regression in `bestCorrelation`'s own overlap-fraction guard
(added earlier this pass to fight coincidental short-window matches) while
testing the "upload with just a bar or two of overlap" workflow: requiring
a *percentage* of the whole envelope to overlap rejected a real, correct
short overlap outright, since a produced outro is *mostly new material* by
design — most of its own envelope was never going to match anything.
Replaced with an absolute ~1-second floor instead (see `audioDetect.js`) —
comfortably under any normal "bar or two," while still filtering the tiny-
window flukes the guard existed for. Detection now clears the confidence
threshold confidently on a short synthetic overlap; the exact computed
cue-point timestamp was off by a few seconds in that same synthetic test —
**correction, see round 7 below: this was a real bug (`bestCorrelation`'s
lag range), not a test-signal artifact as guessed here.**

### Done this pass (round 7 — a real non-periodic detection test; found and fixed the actual cue-point bug)
Built a proper non-periodic synthetic test per explicit request (random-
walk/sparse-hit amplitude envelope over white noise, seeded — see
`.scratch/gen_signals.py` in that session, not checked in) specifically to
avoid the round-6 test's flaw (a smoothly periodic signal can alias against
itself at the wrong lag and *look* like a detection bug when it isn't).
Verified self-similarity was low before trusting it, then built three
cases with byte-exact overlaps and known ground truth: an outro (song's
own last 2s + 3s new), an intro (3s new + song's own first 2s), and a
transition (songA's last 2s + 2s new + songB's first 2s).

This surfaced a real, previously-undiagnosed bug: `bestCorrelation`
(`audioDetect.js`) capped its lag search at `±(min(a.length, b.length)-1)`
— symmetric around zero — but the two envelopes it compares are almost
never the same length (the dropped clip's own short edge vs. a reference
song's usually-full 10s edge window), so the *correct* lag routinely fell
outside that range entirely on the longer side. Measured directly: a
byte-exact splice scored 0.84 at its true lag (160) but that lag sat
outside the old ±99 window, so the search returned some unrelated in-range
lag with a much weaker score instead. This is almost certainly what
produced round 6's "cue point is off by a few seconds" result, not the
periodicity theory recorded there. Fixed by searching the full valid
range, `-(a.length-1)` to `+(b.length-1)`.

With that fixed, **every splice-point measurement across all three cases
was exact (0 error against ground truth)**: outro outSeconds, transition's
both cue points, and intro's inSeconds. Per the explicit pass condition —
"the test passes if the original + outro is seamless" — **this passes**:
playing the song up to the detected outSeconds and then the outro clip
from its own start reconstructs the original audio exactly, with neither
a gap nor a repeated segment, byte-for-byte.

Also found, and partially addressed, a second and more concerning issue
while doing this: the *type* classification (does this also match on the
other side, making it a Transition instead of a plain Outro/Intro) has a
real false-positive risk baked into a "best score over ~200-300 candidate
lags" search — trying that many lags means even unrelated audio
occasionally clears a flat confidence threshold purely by chance (an
"look-elsewhere" statistical effect, not something a threshold tweak fully
closes). Measured a genuine match consistently scoring 0.84-1.0 and a
false one still reaching 0.80 in testing. Raised `MATCH_THRESHOLD` from
0.55 to 0.7, which fixed the outro case's misclassification but did not
fully close the intro case's — **this needs a real fix, not another
threshold nudge: require the winning lag to beat the best score at every
*other* lag (excluding a small window around the winner) by a real margin,
the way audio fingerprinting tools disambiguate a genuine match from
coincidental noise, rather than just clearing an absolute floor.** This is
very likely the root cause behind the user's separate "type auto-detect
isn't reliable" complaint (round 6) — the splice-point math was never the
problem, the same-side-vs-other-side classification was.

### Next up — requested, not yet built
- **Type-classification robustness** (see round 7 above) — a margin-over-
  runner-up check in `bestCorrelation`/`detectMatch`, not another threshold
  tweak. Concrete finding to build from: a genuine match scores 0.84+, a
  coincidental false one can still reach 0.80, so absolute thresholds alone
  can't fully separate them — the winning lag needs to be a clear outlier
  among all lags tried, not just clear a floor.
- **A real preview player for Add Audio.** The current `<audio controls>`
  is too small to actually tell whether a detected transition is right —
  the user wants something purpose-built: show the detected in/out points
  visually on the waveform (not just a numeric readout), and make it
  possible to *see* the splice — the goal is a genuinely seamless
  transition, so there should be nothing audible to distinguish "before"
  from "after" the cue point, meaning a visual marker at the real detected
  timecode is what actually proves it worked, not just trusting the number.
  Explicit note from the user: **out-point detection already looks right —
  it's specifically the type (intro/outro/transition) auto-detect that
  isn't reliable.** Don't touch the out-point math while working on this;
  focus on the player UI and the type classification.
- Related correctness point the user flagged: an outro/transition clip is
  uploaded "with the original song still attached" *only* far enough to
  make the splice detectable — ideally just a bar or two of overlap, not
  the whole song — and detection needs to find and sync to that overlap
  correctly at that short length. Tested directly this pass with synthetic
  audio (a rhythmic pulse pattern, since the RMS-envelope approach here can
  only key off amplitude/energy shape, not pitch/timbre — two clips at the
  same loudness but different pitch look identical to it, so any manual
  test of this needs actual rhythmic/percussive variation, not a plain
  tone). Found and fixed a real regression from earlier this pass:
  `bestCorrelation`'s "require most of the *shorter* envelope to overlap"
  guard rejected a real, correct 2-second overlap outright, since a
  produced outro is *mostly new material* by design — most of its own
  envelope was never going to overlap with anything, so requiring a
  percentage of it punished exactly the short-overlap case this exists to
  detect. Replaced with an absolute floor (~1 real second of overlap,
  comfortably under "a bar or two" at any normal tempo) instead of a
  percentage. With that fix, a short 2-second overlap now clears
  MATCH_THRESHOLD confidently (~0.78 in the synthetic test). The *exact*
  cue-point timestamp it computed was off by a few seconds in that same
  test, which looks like an artifact of the synthetic signal being too
  perfectly periodic (a steady, repeating pulse gives the correlation
  search several similarly-good false alignments, not just the true one) —
  real music has enough natural micro-variation that this shouldn't
  reproduce, but it's genuinely untested against real recorded audio.
  **Don't treat short-overlap cue-point precision as fully verified —
  confirm it against a real short-overlap upload before relying on it.**

### Done this pass (round 8 — node redesign, part 1: Selected/Active model, canvas placement, wiring fixes)

A single very large "redesign the nodes" request came in with many parts.
This round covers the foundational interaction-model pieces; the visual
socket/dropdown redesign itself (see "Next up" below) is still queued.

- **Selected vs Active, for real.** Active (`session.nowPlayingId`) is
  whatever's actually sounding; Selected (`selectedId`, PerformPage.jsx) is
  purely "what was last clicked" and never has a playback side effect on
  its own. A new right-side **detail pane** (`DetailPane`, PerformPage.jsx)
  shows the selected song's cover/BPM/key/duration and its socket state,
  with one Play button that's the only thing that starts or jumps
  playback. Verified end-to-end with Playwright: selecting a node never
  plays it; clicking Play on an arbitrary node mid-set correctly hands off
  and the set keeps following *that* node's own wiring afterward.
- **Playing/Next/Later is gone from the Graph tab** — `stateFor` now
  returns only `'active' | 'selected' | null`; removed the legend swatches,
  `nextRows`/`laterRows`/`nextCandidateIds`/`laterCandidateIds`, and the
  hover-preview "later" system entirely (see the glossary above).
- **Toolbar simplified to Start / Pause / Stop.** The separate "End Set"
  button and its confirm modal are gone — ending gracefully was already
  just a consequence of a song's own wiring leading into the End node
  (`playlistNextHop`); the manual trigger was a redundant, riskier way to
  do the same thing, and the user explicitly didn't like it as a distinct
  control.
- **The graph no longer force-loads every library song as a node.**
  `session.canvasIds` tracks which songs actually have a placed node
  (migrated once from whatever's already on-screen, so nothing existing
  gets wiped). The pane's right-click "Add node here" now searches and
  places an *existing* library song (no upload form — a real
  misunderstanding from an earlier request, now corrected) at the clicked
  spot; a node's own context menu gained "Remove from graph" (takes it off
  the canvas, disconnects its wires, leaves the song itself untouched in
  the Library — separate from "Delete song").
- **Canvas click/drag behavior fixed.** Left-drag on empty canvas now
  draws a selection box by default (`onSelectionDragStop` persists every
  node that moved together); panning moved to holding Shift while
  dragging. Fixes a real reported bug: the old default (plain drag pans)
  meant dismissing a right-click menu had no way to "undo" itself — the
  pane's own default gesture fought the menu instead of just closing it.
- **Start Set wiring bug, root-caused and fixed.** Reported directly: wire
  Start Set to song A's None socket, then separately wire song B's Outro
  into A's Intro socket, and the two silently fought over one shared field
  (`nodes[A].startMode`) — whichever wire was drawn second won, and the
  other's own choice was lost even though its *pointer* (`startSongId` /
  `nextSongId`) was still intact. This is a genuinely non-linear editor —
  a song can be reached by Start jumping straight to it *and* by another
  song's Outro/Transition leading into it, and those two paths can
  legitimately want different arrival styles. Fixed by giving Start its
  own independent `activePlaylist.startMode`/`startEdgeId` fields instead
  of writing into the destination song's shared node entry (`wireStart`/
  `unwireStart`, core.js); `socketDataById` now merges both sources for
  display, preferring the ordinary wire's mode when one exists. Verified
  via the actual drag-and-drop UI (not just the data layer) that both
  wires now persist and each drives its own real behavior correctly.
- **Player bar moved to the bottom of the page**, volume collapsed to an
  icon that only reveals its slider on click (most controls should
  disappear until clicked), and it now shows what kind of hop
  (transition / outro→cut / cut→intro / etc, via the existing `hopSummary`
  helper) is coming up between Now Playing and whatever's next. The
  playhead (`Playhead`, SequencePane.jsx, reused here) got a short CSS
  transition so its 1Hz tick reads as smooth motion instead of visibly
  stepping, without any per-frame JS.

### Next up — the rest of the node redesign, not yet built
Still queued from the same original request:
- **Socket rows → one dropdown per side, styled as a progress bar.**
  Superseded, not built: the shipped mockups (`socket-redesign-v6.html`,
  `screen-atlas.html`) that this whole node redesign has since been
  ported from (see round 11 below) both kept the 3-stacked-rows-per-side
  structure with an inline picker on the active row, not a collapsed
  single dropdown — building this on top would mean two competing socket
  UIs at once. Worth a direct decision before ever touching this again:
  either the mockups' direction has quietly replaced this idea, or it's
  still wanted and the mockups need updating first.
- **A better collective name for "intro/outro/transition"** — user asked
  for a proposal, still not made beyond a placeholder suggestion:
  "arrival/departure style" or "hop style" both read naturally in a
  sentence ("this song's departure style is Transition") and match
  language already used in code comments (`docs/playback-model.md`,
  `core.js`'s own "arrival style" phrasing) — neither has been run past
  the user as a real decision yet.

### Done this pass (round 20 — Autoarrange stopped collapsing into a line, socket rows name what's actually selected, Active dropped its size change, Selected+Active can show together, Start's button is always visible)

Five node-editor UX reports in one message, all confirmed real and fixed:

- **Autoarrange "just turns the graph into a line."** Two distinct real
  causes, both in `computeDagreLayout` (graphLayout.js): (1) any song with
  zero wiring has no edge for dagre's rank algorithm to place it by, so
  every such song landed at the same rank, stacked one below the next —
  confirmed directly: a library with no active wiring at all (the ordinary
  state right after adding songs, before sequencing them) put all of them
  in one long vertical column regardless of count. (2) a real, mostly-
  linear DJ set — commonly dozens of songs chained in sequence — legitimately
  ranks as one long chain, which dagre's LR layout draws as one long
  horizontal strip with no notion of wrapping. Fixed both: songs with no
  real connection to anything are now packed into their own grid instead of
  fed to dagre at all; the wired portion's own ranks get grouped and
  wrapped into bands capped at a fixed width once there are more than a
  handful, snaking alternate rows back the other direction (like text
  wrapping) so a wire crossing a row boundary only ever drops straight down
  instead of jumping back across the whole canvas. Verified directly
  against the real 50-song three-artist example graph (previously one
  unbroken 50-card row) — now a legible multi-row grid, zero overlapping
  positions, confirmed at several other graph shapes (fully unwired,
  mixed wired/unwired, a chain feeding End Set) too.
- **Socket labels only ever showed the bare type name.** The original plan
  (raised early this session, tabled, now revived): "None"/"Intro"/
  "Outro"/"Transition" only ever means "nothing picked here yet" — once a
  slot is actually filled, the row should say what's really playing
  through it. None keeps the plain type name always (a straight cut has
  no real audio piece to name); Intro/Outro/Transition now resolve to the
  *other* song actually involved — whichever song a filled Outro/
  Transition leads to, or whichever song a filled Intro arrives from
  (`leftFilledLabel`/`rightFilledLabelByType`, socketDataById in
  PerformPage.jsx) — falling back to the type name only when there's
  nothing real to name yet (toggled on, no destination chosen). A row with
  several real candidate variants still shows the picker's own variant
  label instead (already more specific than a bare destination name, e.g.
  distinguishing two different built transitions to the very same song).
- **Active made the card bigger and shifted its wires.** `.state-active`
  carried `transform: scale(1.08)` since round 8 — despite a comment right
  above it explaining exactly why hover deliberately never does this (a
  transform changes the card's, and every socket nested inside it,
  measured position, which is what any connected wire actually anchors to)
  — active being the one exception was never revisited. Removed; Active is
  color/animation only now, footprint unchanged.
- **No visible highlight when a node is both Active and Selected.** Traced
  to `state` being one exclusive value (`'active' XOR 'selected'`) — a
  node that was both playing and the last-clicked one always showed only
  Active's fill, never Selected's ring. Split them into two independent
  signals (`stateFor` for Active, a separate `isSelected` threaded straight
  from `selectedId`) and moved the selection ring onto its own `::after`
  layer instead of the card's own `box-shadow` — necessary, not just
  tidier: `.state-active` drives its own `box-shadow` via the `pulseRing`
  animation, and a running CSS animation always wins the cascade for
  whatever property it's animating, so a plain same-element ring would
  have been silently overridden the instant a selected card also went
  Active. A separate paint layer sidesteps the conflict outright. Also
  retroactively fixes the old hover-vs-ring clobbering workaround (two
  duplicate hover-combining rules, one for single-select one for multi-
  select) — with the ring off on its own layer, the base element's hover
  lift never has anything left to clobber, so both duplicate rules came
  out entirely.
- **"I don't see the play button on the play node."** The Start node's
  play button (round 19) required both "nothing playing yet" *and* a real
  wired entry point — with nothing wired, the button didn't render at all,
  which read as broken rather than simply inert. Now it always renders
  once nothing's playing, greyed out and disabled until a real song is
  wired — the same convention every other not-yet-usable control on this
  canvas (an unavailable socket row) already uses instead of vanishing.



Six separate asks in one round, plus a live crash the user hit mid-pass:

- **Contributor attribution.** A lightweight per-browser identity
  (`core.js`'s `getProfileName`/`setProfileName`, `localStorage`-backed, no
  login) — a "Your name" field in Settings. Every song/audio piece added
  now carries `contributedBy`, stamped centrally in `App.jsx`'s
  `addSong`/`onAddEdge` rather than at each upload call site. Shows as a
  small tag on a node card (GraphNodes.jsx) and a Library row/built-audio
  fragment (Library.jsx) whenever it's actually set — a solo library
  (nobody ever set a name) shows nothing, by construction, not by a mode
  check. Threaded through the shared-crate schema too: `crate_songs` grew
  `contributed_by`/`extra_files` columns, `crate_edges` grew
  `contributed_by` (migration `add_contributor_attribution_and_extra_files`),
  and crateStore.js's row-mapping functions carry both both ways.
- **Extra file attachments.** A song can now hold arbitrary extra files —
  stems, the original project file, anything worth sharing beyond the
  master — via a new `uploadExtraFileIfPossible` (core.js, mirrors
  `uploadAudioIfConfigured`'s worker-or-IndexedDB path, generic content).
  Library.jsx's drawer gained an "Extra files" section: multi-file picker,
  per-file download (`useResolvedAudioUrl`, already marker-agnostic) and
  remove.
- **Live-crossfade pulse.** The `animated`/`active-edge-animated` wiring
  on the currently-mixing edge (GraphPane.jsx's `mixingEdgeId`) has existed
  since round 8 but was never actually styled — confirmed by grepping for
  its CSS class and finding nothing. Added a genuine effect: a second
  `<path>` on top of the solid base line, dashed white, `stroke-dashoffset`
  animating negative (source → target, matching the path's own draw
  direction), so a few bright dashes visibly travel along the live
  crossfade repeatedly. Tripped on React Flow's own `base.css`, which
  applies `.react-flow__edge.animated path { animation: dashdraw }` to
  *any* path inside an animated edge indiscriminately, at higher
  specificity than a bare new class — silently overrode both the base
  line (making it dash) and the new overlay (making it use their rhythm,
  not this one). Fixed by reasserting both paths explicitly at
  matching-or-greater specificity. Verified via `getComputedStyle` in a
  live-mixing fixture: base path solid/`animation: none`, overlay path
  actually running `playbackFlow`.
- **Start node play button.** `StartNode` (GraphNodes.jsx) now renders a
  real play button (mirrors the toolbar's own Start button, same ink/paper
  colors) when a real entry point is wired and nothing's playing yet —
  calls the same `triggerStartSet` the toolbar button already used.
  Disappears once a set is running, same as the toolbar button it mirrors.
- **Detail pane destinations.** Fixed a real, live-reported crash (see
  below) and used the same touch to add the actual ask: each active output
  row in the detail pane's Output section now shows its real destination
  song (or "ends the set" for End) with a small green dot — a genuine
  color, not this app's usual ink-only palette, deliberately: a live-status
  signal reads as a different kind of thing than a decorative accent.
- **Live crash, found via a user report mid-pass**: clicking a node threw
  `Cannot read properties of undefined (reading 'length')` on the deployed
  site. Root cause: round 18's `socketDataById` rewrite replaced the
  right/output side's old singular fields (`rightActive`/`rightOptions`/
  `rightEdgeId`/`rightCueSeconds`) with the new multi-type shape
  (`rightActiveTypes`/`rightOptionsByType`/etc.) everywhere except
  `PerformPage.jsx`'s own `DetailPane`, which still read the old field
  names — `sd.rightOptions.length` on `undefined` is exactly this error.
  Rewrote `DetailPane`'s Output section against the real shape (one row
  per active type). A sweep for the same stale shape elsewhere (the user
  asked directly: "fix any related or similar issues") turned up a second,
  not-yet-triggered instance — `GraphPane.jsx`'s `socketDataById[id] ||
  {...}` fallback default object, used whenever a song briefly has no
  entry in the map yet, still built the old shape too — fixed the same
  way, plus a defensive `activeTypes = []` default added to `SocketList`
  itself. Verified the exact crash no longer reproduces (a Playwright
  repro clicking a multi-type-output node), then re-ran every existing
  multi-output/multi-input/legacy-fallback regression test from rounds
  16-18 to confirm the fix didn't disturb anything else. One of those
  re-runs briefly looked like a new regression (drag-connect producing no
  wire) — traced to Playwright test flakiness in an old test's own drag
  helper (too few pointer-move steps for this sandbox's timing), not an
  app bug: confirmed by reproducing the identical symptom against the
  pre-this-round commit, then confirming a slower, more realistic drag
  succeeds on the current code either way.

### Done this pass (round 18 — a node's output side now supports multiple simultaneous active types)

Follow-up to round 16's multi-io fix, which only covered multiple
*Transition* wires out of/into a socket. Sent a screenshot of two lines
converging on one destination and clarified the real ask: a single node
should be able to have **None AND Outro AND Transition all active at
once**, each with its own destination(s), not just several Transitions
of the *same* type — random playback picks the socket type first
(None/Outro/Transition), then the destination within that type. The
arrival/input side stays single-slot on purpose ("multiple intros/outros/
transitions per destination should be off the table for now").

Implemented by generalizing every place that used to assume "a node has
at most one active output" into one shared shape: `nodes[id].outputs` is
now always an array of `{type, edgeId, targetId}` entries (any mix of
types, each independently addable/removable), read through one exported
helper, `nodeOutputs(node)`, that also synthesizes this shape on the fly
from the old single-mode fields (`endMode`/`nextSongId`/`endEdgeId`) so
nothing already saved needs a migration. `wireConnection`,
`addTransitionConnection`, and the new `removeOutput` (replaces
`removeTransitionConnection`) all read/write through this one shape;
`removeOutput` only clears a destination's shared arrival field
(`startMode`/`startEdgeId`) when it's still pointing at exactly the entry
being removed, since some other active output — from this node or
another — may have since claimed it. `playlistNextHop` does the two-stage
random pick: uniform over active types, then uniform over that type's
destinations. `GraphPane.jsx` draws one edge per active non-Transition
entry (previously "at most one plain link per node") alongside the
existing one-edge-per-produced-Transition loop; `GraphNodes.jsx`'s
`SocketList` now takes `activeTypes`/`optionsByType`/etc. (arrays/maps)
instead of a single active value, so a socket column can show more than
one row bolded at once.

Verified: a 4000-draw Monte Carlo on `playlistNextHop` confirms the
two-stage pick is uniform within both stages; a live-rendering test wired
one node to three simultaneous destinations (None/Outro/Transition) and
confirmed all three edges render with the right handles and all three
socket rows show active; re-ran the round-16 multi-output/multi-input
drag tests and the legacy-shaped-node fallback test against the new
unified model with zero regressions; confirmed a hover-✕ disconnect or a
socket-dot toggle on one type never touches another active type on the
same node (including the destination's shared arrival field only
clearing when it was actually pointing at the removed entry); confirmed
toggling a type on with no destination chosen yet shows the socket as
active without drawing a phantom edge. One early run of the rendering
test showed a missing edge — traced to invalid test fixture data (a
destination node's `startMode` set to `'outro'`, which was never a legal
arrival-side value; the real bug list is otherwise empty).

### Done this pass (round 17 — shared live crates, producer-friend collaboration)

Asked directly for a shareable link so producer friends can open the real
editor and contribute songs/audio into the same library. Given the real
data-loss risk of extending the existing whole-blob-overwrite personal
sync to multiple simultaneous writers, ran the correctness-check process
first — full spec at **`docs/live-crate-collab-design.md`** (ten concrete
concurrent-write scenarios, derived before any schema/sync code was
written) — which surfaced one genuinely open question rather than
guessing at it: the request was specifically "contribute songs and
audio," narrower and safer than "collaboratively wire the live set
together." Put both options to the user directly; picked **W1 — shared
song/edge pool, private wiring**: each collaborator's own graph wiring
and playback session stay local to their own browser, never synced,
which makes "a remote edit can never touch anyone's live performance
state" true by construction instead of something needing active
enforcement.

Implemented: real per-song/per-edge Supabase tables (`crates`/
`crate_songs`/`crate_edges`, RLS scoped to "anyone with the crate id" —
same model the already-public R2 audio objects use, not per-user like the
personal `library` table), Realtime subscriptions for live incremental
updates, and `src/crateStore.js` + `App.jsx` wiring that's a fully
separate code path from personal-library sync (a crate can never read
from or write into a visitor's own solo library). A "Shared crate"
section in Settings starts one (seeding it from the current library),
copies the link, or leaves — "Clear all data"/"Restore from a backup"
are disabled inside a crate since either would wipe the shared pool for
every collaborator, not just the local browser.

Verified the database layer directly (real anon key, plain REST, insert/
read/update/delete all round-tripped correctly) and confirmed zero
regression on the existing personal-library path. **Not** verified
end-to-end live in this dev sandbox — its outbound proxy doesn't support
WebSocket upgrades (Realtime's transport) and browser-originated requests
to Supabase were failing at the proxy layer in ways plain `curl` from the
same sandbox wasn't. Real cross-browser live sync needs a smoke test
against the actual deployed site before relying on it for a real session
— see the design doc's own "Status" section for exactly what is and
isn't confirmed.

### Done this pass (round 16 — three real graph bugs, root-caused against reproductions; example set doubled)

Four things reported directly in one message, from a screenshot of
Autoarrange drawing a genuinely broken layout:

1. **Autoarrange placing a multi-output destination nowhere near its real
   source** (the reported "huge diagonal link"). Root cause had nothing to
   do with cycles, despite how it looked — `computeDagreLayout` only ever
   fed dagre a node's `nextSongId` (the single most-recently-wired
   transition); a node's *other* transition(s) were completely invisible
   to the layout, so that destination had zero positional link to its
   real source and landed wherever dagre parks a disconnected node. Fixed
   with a new `allDestinationIds(node)` (core.js) that enumerates every
   real destination, not just the first; `graphLayout.js` now feeds dagre
   one edge per destination. Verified against the exact reported scenario
   (both destinations now land in the same downstream column) and against
   a genuine closed loop (a supported feature) to confirm the one
   unavoidable closing edge still renders as a clean curve.
2. **A second transition silently dropping the first**, still reproducible
   on any node whose data predates the `transitions` array —
   `addTransitionConnection` rebuilt its candidate list from
   `node.transitions` alone, no fallback to the old singular
   `endEdgeId`/`nextSongId` fields the way `playlistNextHop` and
   `removeTransitionConnection` already correctly had. Pulled the
   fallback into one shared `existingTransitions()` helper used by all
   three, so a fourth call site can't drift out of sync the same way
   again. This (not a UI/interaction bug) is what "still can't have
   multiple inputs/outputs" actually was — multi-output/multi-input
   already worked correctly for freshly-wired data; it only broke on
   anything wired before this feature existed.
3. **Clicking empty canvas didn't clear a selected node** — `selectedId`
   is plain component state, never tied to React Flow's own
   node-selection, so React Flow's own pane-click deselection was never
   going to touch it. Wired a real `onPaneClick` handler through
   `GraphPane` into `PerformPage`.
4. **The example set doubled** (26 songs → 50) with a third real,
   recognizable tracklist (*Whole Lotta Red*, Playboi Carti — same
   factual-metadata-only treatment as the existing two, original flat-
   color swatch covers, no redistributed artwork) and, critically, wired
   *active* on load now (`loadExample` runs `autoconnectFullGraph` over
   the whole set) rather than handing over 50 songs of unwired sockets —
   deliberately including a multi-output node (Pi'erre's last track
   branches to both Kanye's and Carti's openers), a multi-input
   convergence (Carti's opener receives from both of those), a second,
   unrelated multi-input example mid-chain, and a full three-artist
   closed loop (Carti's closer back to Pi'erre's opener) — the example
   now demonstrates every one of the bugs above being fixed, not just a
   bigger version of the same one straight chain.

All four verified against real reproductions (Playwright, real drag-connect
gestures and real Autoarrange runs) before and after each fix, not just
against the example set's own happy path.

### Done this pass (round 15 — BPM/key detection re-enabled, root-caused against real music)

`audioAnalyze.js`'s BPM/key detection had been disabled since well before this
handoff — `analyzeAudio` hardcoded `{ bpm: null, key: null }`, with a comment
citing a sine-wave test tone confidently coming back "140 BPM, A maj." Asked
directly to actually get it working, with two real, individually-verified
songs uploaded as ground truth to test against instead of guessing:

- **Root cause**: the onset-autocorrelation (BPM) and chroma-correlation
  (key) math were never actually wrong — reproduced the exact original sine-
  tone failure, then ran the same code against two real tracks (one cross-
  checked against Beatport/Tunebat: 160 BPM, B major) and it landed within
  1% on BPM and got the key exactly right on the very first try, no tuning.
  The real defect: neither estimator had any confidence gate, so `argmax`
  over pure noise (no rhythm, no chord content) still returned *a* winner.
- Researched established alternatives before patching (`web-audio-beat-
  detector`, Essentia.js's `RhythmExtractor2013`/`KeyExtractor`) rather than
  assuming the home-grown approach was worth keeping by default. Verdict:
  `web-audio-beat-detector` is well-maintained but empirically *less*
  robust across a wide BPM search range than the existing code — it only
  found the correct 160 BPM once the search range was hand-narrowed to
  140-180; left untouched it landed on an unrelated wrong value (105) or
  the half-time octave (80). Essentia.js would work but pulls in a WASM
  bundle for an editable, non-critical prefill field. Chroma + Krumhansl-
  Kessler correlation (what's already here) *is* the standard textbook
  approach for pure-JS browser key detection — confirmed via research that
  the same technique is what every other pure-JS browser key-finder tool
  uses. Kept and fixed the existing DSP rather than replacing it.
- **The fix** (`estimateBpm`/`estimateKey` in `audioAnalyze.js`): a
  confidence gate on each (BPM: winning lag's autocorrelation as a fraction
  of the zero-lag value, must clear 0.15 — real tracks scored ~0.35, the
  sine tone scored 0.07; key: requires both a minimum correlation score
  against the best-matching profile AND at least 2 independently-lit chroma
  bins, since a single sustained pitch alone can still score deceptively
  high against a profile's own tonic weighting — confirmed directly, the
  sine tone's "A maj" scored 0.68, as strong as a real correct answer).
  Below the gate, both return `null` rather than a guess — the same
  "detected but editable, never a wrong-looking guess" contract Add Audio's
  transition detection already uses. Also added: parabolic interpolation
  across the winning lag's neighbors for sub-frame BPM precision (closed a
  real track's 161.5-vs-160 gap), and octave canonicalization (double/halve
  into an 85-170 "typical" range — the same convention rekordbox/Serato/
  Mixed In Key use, since a tempo and its exact half/double are
  fundamentally indistinguishable to any autocorrelation-based detector).
- Re-enabled `analyzeAudio` for real; Upload Song's "BPM/Key aren't
  auto-detected" copy (stale since the feature was disabled) updated to
  reflect current, accurate state per-field.
- Verified end-to-end via the real Upload Song UI (`setInputFiles`, not a
  synthetic call) against: the 160 BPM/B major track (correctly prefilled
  161 BPM / B maj), a second real track with an ambiguous/atonal chroma
  (correctly prefilled a cross-validated ~110 BPM, correctly left Key
  blank rather than guessing), and the original sine-tone failure case
  (correctly left both blank, with an honest explanation shown).

### Done this pass (round 14 — implemented all four round-13 audit recommendations)

Asked directly to implement round 13's four findings, then verify the
whole live site end-to-end. All four are in and Playwright-verified
against a real dev server (drag gestures, not teleporting clicks):

- **Connecting-handle `.invalid` state** — `styles.css`, right next to the
  pre-existing `.valid` rule (which, corrected from round 13's own
  research, already existed — a bad grep pattern caused a false "missing"
  finding there; only `.invalid` was actually new). Same box-shadow-only
  technique, `var(--danger-bg)`/`var(--danger)` instead of the ink ring.
- **Selection box recolored** off React Flow's stock blue — `.graph-pane
  .react-flow` now sets `--xy-selection-background-color`/`--xy-selection-
  border` to rgba literals matching `--accent`.
- **Middle-mouse-button pan** — `panOnDrag={[1]}` in `GraphPane.jsx`,
  additive alongside the untouched Shift-drag/box-select split.
- **Grid-snap on drag release** — `onDragSongPosition` (`PerformPage.jsx`)
  quantizes to the nearest 22px (matching the dot-grid background) before
  persisting; deliberately not applied to Autoarrange's own dagre output.

Full end-to-end QA pass after: fresh build (clean), and a real Playwright
run through every screen (Graph/Library/Upload Song/Add Audio/Settings)
and every graph interaction (play/pause via the detail pane, search,
single- and multi-select with their respective context menus — confirmed
"Delete song" is still gone and "Autoarrange" still correctly named,
socket variant picker, light/dark theme toggle). No console errors or
regressions found — the only failed network requests seen were Google
Fonts and Supabase auth being unreachable from this sandboxed dev
environment specifically (Supabase anonymous sign-in is real but not yet
flipped on in the dashboard — a known, already-documented manual step,
not a code bug); neither would be an issue on the real deployed site.
`docs/blender-node-editor-audit.md` updated in place to mark all four
recommendations implemented and correct the `.valid`-state research
mistake.

### Done this pass (round 13 — Blender node-editor UX audit, documentation only)

Asked directly, after round 12 finished the full screen port: look through
Blender's node editor for anything worth stealing for the graph canvas —
"a slow viewport, a jittery input, lack of ux polish in the form of hover
states, snap anticipation, all these little things, every single one
should be documented." A documentation deliverable, not an implementation
one — nothing below has been built yet.

Full writeup: **`docs/blender-node-editor-audit.md`**. Every item was
checked against Eskimo's actual current code (`GraphPane.jsx`,
`GraphNodes.jsx`, `styles.css`, `@xyflow/react` v12.3.6's real defaults),
not assumed from memory of either codebase. Four concrete, scoped gaps
came out of it, in priority order:

1. **No visual feedback while dragging a wire toward a socket** — this is
   the direct hit against "snap anticipation." React Flow already applies
   `.connectingto.valid`/`.invalid` classes to candidate handles during a
   drag; nothing in `styles.css` styles them, so a 40px-radius forgiving
   hit-test (`connectionRadius={40}`) has zero matching visual confidence
   before you let go.
2. **The drag-select box is still React Flow's stock blue** — the one
   remaining default-blue element after round 11/12's whole point-of-the-
   exercise pivot away from blue-accent conventions onto ink + one pastel
   accent. Never overridden; confirmed by grep, zero hits.
3. **No middle-mouse-button pan** — panning currently requires holding
   Shift while dragging (deliberate, fixes a real past bug, don't touch
   it) but has no second, unclaimed input alongside it the way Blender/
   Figma/etc. all offer MMB-drag for exactly this.
4. **The visible 22px dot-grid background implies alignment nothing
   honors** — node drag has no snapping at all, onto that grid or
   otherwise. Grid-only snap-on-release is the safe version to build;
   Blender's own users report its node-to-node snap variant as
   "unpredictable" (cited in the doc) — don't copy that part.

Also documented at length, and explicitly **not** recommended, with
reasoning for each: node header color-by-category (Eskimo's Song nodes
already use per-song cover-derived color, which does that job better for
a graph made of one dominant node type), socket color-by-data-type
(deliberately removed earlier this session — mockup correction, sockets
already carry a text label), Blender auto-offset/reroute-node/link-drag-
search/Node-Wrangler-style hidden shortcuts (don't map cleanly onto a
graph of fixed song entities), and a minimap (Blender's own core doesn't
ship one either — third-party addon only — and Eskimo's graphs are nowhere
near the scale where one earns its screen space).

### Done this pass (round 12 — the mockup port, finished: every other screen + a real backdrop)

Round 11 (below) only ported the graph/node screen's real scale — asked
directly to finish the rest ("when I said everything I meant
everything"), same measure-the-mockup-don't-eyeball-it method applied to
Library, Upload Song, Add Audio, Settings, and the app shell:

- **Library**: `.lib-row` was a flat bordered accordion list — now
  individually elevated borderless/shadow cards (`.node-card`'s own
  recipe). Native checkbox restyled to a real custom checkmark box
  (`appearance:none` + a drawn `✓`, keeping real checkbox semantics)
  instead of the browser's default plus an off-palette accent-blue
  `accent-color`. `.lib-select-bar` switched from solid ink to the
  accent-bg/accent-text treatment already used for other "you're in a
  selection state" banners.
- **Settings**: new `.settings-card` (same borderless/shadow language as
  `.form-card`, smaller padding since each `.settings-row` carries its
  own padding + a divider). Its previously-separate, near-duplicate
  `.autoplay-card`/`.autoplay-row`/`-title`/`-sub` classes are gone,
  unified onto `.settings-card`/`.settings-row`. `.switch.on` (Autoplay/
  Transition-only toggles) went from accent blue to ink, matching the
  app's own near-monochrome + one-pastel-accent convention.
- **Upload Song / Add Audio**: `.form-card` went from a flat grey panel
  to the same borderless/shadow-elevated treatment (background
  panel→paper, real shadow, radius 2→6px, padding 14→20px) — deliberately
  did NOT copy the mockup's own bigger inter-field gap verbatim, since
  real fields are wrapped in `.field` (its own margin-bottom already),
  and doubling up would have overshot the intended spacing.
  `.dropzone` padding/border/gap bumped to match.
- **`.segmented`** (Light/System/Dark, also used in dark contexts like
  the sequence pane's own ending buttons) drops its border/per-button
  dividers for a shadow — deliberately did NOT force a background/text
  color the way the mockup's flat version does, since an existing
  comment documents why that specifically broke a dark-context usage
  before (invisible near-white-on-near-white buttons); a box-shadow
  doesn't touch color, so it's safe to add unconditionally where the
  border wasn't.
- **A real backdrop for every page, not just the graph canvas.** Every
  card this pass (and round 11) has been adding was floating on the
  exact same flat white as the page itself — a shadow alone barely
  reads with nothing to contrast against, which the graph canvas never
  had this problem with (its own dot-grid already gave it visual
  depth). New `--canvas-bg` token (light/dark, matching the mockup's own
  exact values) applied to `.main` — the whole app shell's content area
  outside the sidebar. `.sidebar` itself switched from `--panel` to
  `--paper` to match (the toned `--main` now does the separation job a
  grey sidebar used to), and `.nav-btn`'s hover tint switched from a
  custom faint rgba (chosen specifically to still show up against the
  old grey sidebar) to the same `--panel` tint every other hover
  affordance in the app already uses.

Verified visually in both light and dark mode across every screen
touched, plus a re-run of the real multi-step-pointer-path drag-connect
regression test after all of it (CSS-only changes, but the graph screen
specifically has burned this session before, so it gets re-checked on
every pass that touches shared tokens/backgrounds).

### Done this pass (round 11 — bug fixes, full mockup fidelity, and the rest of the backlog)

Prompted directly: "start working on literally everything that was
talked about... finish everything," plus one bug report (hover clobbering
the selected ring) and several follow-on corrections mid-round.

- **Fixed: hovering a selected node lost its accent ring.**
  `.node-card.state-selected`/`.node-hovered` set `box-shadow` at equal
  specificity with no rule combining them, so whichever was declared
  later in the stylesheet won outright. Added a higher-specificity rule
  that layers both shadows together.
- **"Arrange for me" → "Autoarrange"; "Delete song" removed from the
  node's right-click menu** (still available from Library — this menu
  now only ever offers the non-destructive "Remove from graph"). The
  dagre layout itself was already left-to-right — only the label needed
  the rename.
- **`occludedTransitions` (core.js) wired into the socket variant
  picker** — an Intro/Outro candidate that would silently hide an
  already-built Transition off/onto the same song now shows a small
  warning badge in its listbox row, tooltip naming what it'd hide.
- **`LiveWaveform`'s spectrum bars smoothed** — each bar now chases its
  target value via exponential smoothing (faster attack than decay, a
  real VU meter's own convention) instead of snapping to each frame's
  raw analyser reading, which read as flicker rather than motion.
- **Full visual-fidelity port from the mockups, not just the border/
  shadow treatment from round 10.** The round 10 port matched
  `docs/design/screen-atlas.html`'s borderless/shadow language but never
  actually measured its *scale* — a direct pixel comparison found the
  real app's node cards, socket dots, and text were meaningfully smaller
  throughout. Ported for real: `.node-card` 208→224px/9→10px padding,
  `.node-art` 26→56px, socket-columns gap 10→22px, `.node-socket-row`
  15→22px height with real padding, `.node-socket-label` 9.5→12px,
  socket dots 9→13px with a recomputed 20px hit-area (kept the documented
  anti-overlap safety margin — see the comment above
  `.graph-pane .react-flow__handle.node-socket::before`, styles.css).
  Also ported a real, deliberate decision from `socket-redesign-v6.html`'s
  own changelog that had never actually been carried into the app: socket
  dots drop their per-type color entirely (green/orange/purple), now
  hollow (grey outline, panel fill) when available-but-not-chosen and
  solid ink when they're the active pick, with light-on-dark overrides on
  an Active card. Sample/demo songs (`sampleSongsForTests`) also went
  from 2 flat cover colors shared across 26 songs to a small cycling
  palette per song, so the color-match feature (already working — see
  the hardening entry below) actually shows real variety on first run.
- **Arrowheads removed from every graph edge** — plain lines; direction
  is already legible from the fixed left-input/right-output convention.
- **Real multi-select.** React Flow's own selection-box drag already
  marked every enclosed node `selected: true` individually — nothing
  read that back out. New `MultiSelectionContext` (GraphNodes.jsx) gives
  a multi-selected node (2+ selected) the same accent ring
  `.state-selected` already uses, kept fully separate from the single
  `selectedId`/detail-pane cursor (verified: a multi-selection never
  changes what the detail pane shows). Right-clicking inside the
  selection hits React Flow's own `.react-flow__nodesselection-rect`
  overlay, not the node underneath — wired the dedicated
  `onSelectionContextMenu` hook for that (confirmed structurally
  necessary via a direct test, not just cleaner code) — its menu offers
  Autoconnect transitions/Disconnect all wires/Remove from graph applied
  across the whole selection in one `setSession` call.
- **Cover/color-match hardening**: `derivePalette` now guards against a
  malformed-but-truthy rgb (falls back to the fixed accent-blue palette
  instead of computing `rgb(NaN, NaN, NaN)`); `usePalette`'s promise
  chain has a `.catch()` as insurance against a future rejection;
  `colorCache` (dominantColor.js) is now capped at 300 entries (plain
  FIFO eviction) instead of growing for the life of the app.
- **Multi-input/output sockets, investigated and mostly already there.**
  Multi-*output* (one song transitioning into several different
  destinations at once, random pick at playback) was already fully
  built in an earlier round — confirmed via `addTransitionConnection`/
  `playlistNextHop`. Multi-*input* (several different songs each wiring
  into the same destination) turned out to already work correctly at
  the data level too: each source's own wiring is untouched by another
  source separately wiring into the same target — confirmed directly by
  wiring two different songs into one destination and checking both
  sides' saved state. The one real gap found was rendering: two
  different sources converging on one destination drew as fully
  overlapping lines (no fan-out existed for that case, only for multiple
  transitions between one *same* pair) — fixed with the same
  perpendicular-offset math, keyed by shared target. The destination's
  own single `startMode`/`startEdgeId` (whether it plays its own intro
  when cut into) staying shared across every source that leads into it
  is correct, not a bug: only one thing plays at a time, so "does this
  song like to play its own intro" is a property of the destination,
  not of whichever source happens to be the one currently leading into
  it — there's no real scenario where that needs to vary per incoming
  wire.
- Every change verified against the real dev server per its own chunk
  (Playwright, synthetic data/audio where relevant) — most notably a
  real multi-step-pointer-path drag-connect re-run after touching socket
  sizing/colors and after adding `onSelectionChange`, both times
  confirming React Flow's live hit-testing still works.

### Next up — graph interactions (the player rewrite below has shipped —
see "Done this pass (round 9 — the player rewrite)")

Graph/canvas interactions:
- **Rename "Arrange for me" → "Autoarrange"**, and have it favor a
  horizontal (left-to-right) layout over vertical — change the dagre
  layout direction bias, not just the label.
- **Remove "Delete song" from the right-click context menu entirely** —
  there's no case where it should be offered there.
- **Selection box should do real multi-select**, like a normal app: every
  node inside the drag box becomes individually selected, not just
  encircled by a bounding box with no per-node selection state.
- **Multi-select behavior**: with multiple nodes selected, `selectedId`
  effectively becomes the whole set, but the detail pane does **not**
  change to show anything for a multi-selection — it stays showing
  whatever it was already showing (or empty), since it's a single-song
  view by design.
- **Context menu adapts to a multi-selection** and applies to every
  selected node: e.g. "Autoconnect transitions" (the per-node action) runs
  across all selected nodes' transitions; "Autoconnect all" is unaffected
  by selection and still means the entire graph regardless of what's
  selected.

Player rewrite — ✅ **done, see "Done this pass (round 9)" below for the
full account.** Kept here for context on what was asked for and how each
point landed:
- This is a **combinatorially-assembled playlist**, not a fixed track
  list. If song A transitions into song B: play A's own audio normally up
  to the wired transition's in-point, then play the transition audio
  seamlessly, then seamlessly resume into B's own audio from the
  transition's out-point onward — never a hard cut between "the graph"
  and "what's actually sounding." Already correct pre-rewrite; the
  rewrite's Plan model (`docs/playback-model.md` §6) made the handoff
  itself sample-accurate on top of this, rather than changing the model.
- **Pause** pauses normally (resumes exactly where it left off, whichever
  of original/transition audio is currently sounding). Already correct in
  the current model — `engine.pause()` suspends the whole AudioContext
  clock rather than tracking play/pause per node, so whatever's actually
  sounding (main deck or a fragment) genuinely freezes and resumes.
- **Skip just plays the next song normally from its own start — it does
  not force a transition.** ✅ Done pre-rewrite already — see
  `docs/playback-model.md` Finding 3: `performAdvance` takes
  `{ forceCut: true }` for a manual skip, which still advances to the
  graph-wired destination but always as a plain cut, never the
  transition's produced clip.
- **Back** goes back to the previous song. ✅ Done — restart semantics
  only (no resume-vs-restart ambiguity, resolved by direct instruction):
  within the first few seconds of the current song, Back goes to the
  previous song and restarts it from 0; otherwise it restarts the current
  song from 0. Always a plain cut, exactly like Skip. See
  `docs/playback-model.md` §6 and `playbackControls.js`'s `goBack`/
  `session.history`.
- **Must support starting playback from any node deep in the graph** —
  ✅ done as the obvious version (Intro-or-cut from offset 0, via the
  detail pane's Play/Start Set), which turned out to be all that was
  asked for. The *deeper* version speculated here — reconstructing "as if
  arrived via some specific transition" — was explicitly dropped, not
  deferred, once asked directly: v2's multi-input model would make a
  destination's single arrival identity ambiguous anyway (`docs/
  playback-model.md` §2's note on why a direct start is its own entry
  mode).
- **Reconceive "Set Start" as essentially a play button** — a way to start
  playback from anywhere without clicking into a node first — rather than
  a wiring concept. Not part of this rewrite; still open if picked back up.
- **Reconceive "Set End" as essentially a stop button**, symmetrically.
  Same — still open.
- **Sample-accurate lookahead scheduling** — ✅ done. The player no longer
  reacts to a 1-second polling tick to decide *when* a hop happens: the
  instant a hop's destination is known and its buffers are decoded, the
  whole chain of `.start()`/`.stop()` calls is scheduled against exact
  future `AudioContext` times (the "Plan" model). The tick loop's only
  remaining job is noticing a fired plan and syncing display state after
  the fact — see `docs/playback-model.md` §6 (Findings 1 & 2, now fixed)
  and §7 for the matching rework of every progress-bar/countdown-ring
  display that used to be driven by the old 1Hz `session.timeLeft`.

### Done this pass (round 10 — porting the design mockups: borderless/shadow visual language + the Add Audio transition preview player)

Two static reference mockups existed only as standalone docs
(`docs/design/socket-redesign-v6.html`, `docs/design/screen-atlas.html`) —
this round ported the genuinely-new parts of both into `src/`, split into
two independent efforts per the approved plan:

**Part A — visual language pass (borderless, shadow-elevated):**
- `.node-card` drops its border for shadow-only elevation at rest/hover;
  `.state-selected` becomes a pure `box-shadow` ring instead of a
  border+shadow combo. Provably safe against React Flow's live
  drag-connect hit-testing since `box-sizing: border-box` is global — a
  border-width change never touches the measured bounding box.
- **Socket variant picker restructured**: a slot with 2+ produced
  candidates used to show a separate full-width dropdown row below the
  two socket columns; it now opens directly from the active socket row
  itself (row's label swaps to the picked candidate's name, click opens
  an anchored listbox) — no separate trigger, no chevron. The old
  `SocketDropdown` component and its CSS are gone.
- `.toolbar-start-set-btn` (Start Set) switched from a one-off saturated
  green to the same neutral ink `.toolbar-stop-set-btn`/`.btn-primary`
  already use.
- `.context-menu` and `.toolbar-btn` diffed line-by-line against the
  mockup (not just assumed to match): context menu went borderless/
  shadow-only like the card; toolbar buttons' resting text color went
  from `--muted` to `--ink` for legibility. `.icon-btn`/`.player-bar*`
  confirmed already identical — no change needed.
- Detail pane's close/play buttons and section titles confirmed already
  matching (the mockup was catching up to already-correct real behavior
  here, not flagging a real diff) — docked layout unchanged throughout.

**Part B — new feature, the Add Audio transition preview player:**
implements the user's own spec verbatim — "show the switch from the
original to the transition and then back to original audio visually...
make sure it only plays like 3 seconds before and 3 seconds after the
transition... full controls including seek, play/pause, volume."
- `src/transitionPreview.js` (new, pure logic): builds one buffer —
  edgeSeconds of the left song ending at its OUT cue, the whole dropped
  clip, edgeSeconds of the right song starting at its IN cue — via
  `audioDetect.js`'s now-exported shared `AudioContext` (decode-time
  resampling means every buffer shares one sample rate for free; channel
  count is reconciled to stereo by hand since that isn't automatic).
  Intro-only/outro-only uploads get one edge slice instead of two rather
  than withholding the dropped clip.
- `src/components/TransitionPreviewPlayer.jsx` (new): a real waveform
  (bar heights from the buffer's own RMS envelope) with the dropped
  clip's span colored/bracketed distinctly from the original audio on
  either side. Real playback via a `AudioBufferSourceNode` + `GainNode`
  — pause/seek stop the current node and start a fresh one at the new
  offset (a source node can't seek in place), anchored the same
  ctx-time-plus-offset way `audioEngine.js` tracks position so the
  rAF-driven playhead can't drift. Dual-target scrub (scrub bar and the
  waveform itself) pauses during the drag and only commits on release,
  same pattern `Playhead` (`SequencePane.jsx`) already uses. Volume
  reuses `PerformPage.jsx`'s own `VolumeControl` classes/popover verbatim.
- Wired into `AddAudioPage` in place of the old bare
  `<audio controls src={previewUrl}>`, once detection has resolved and
  at least one side matched; the whole-file native player stays as the
  fallback for a completely unmatched drop.
- Verified end-to-end against the real dev server: real uploaded
  reference masters, a real dropped clip, region math/bar coloring
  matching the clip's actual length, a playhead that advances in real
  time and stops exactly on pause (no drift), click-to-seek on the
  waveform, and Save still working afterward.

Each of the plan's 9 chunks (A1–A5, B1–B4) is its own small commit,
per this app's per-commit Vercel deploy.

### Done this pass (round 9 — the player rewrite: sample-accurate scheduling, Back, and every jumpy progress display)

The user asked for the deepest possible dive on the playback engine —
"the progress bars... too jumpy, unreliable, and sometimes stall along
with the audio", explicitly for a live-performance context where accuracy
and low latency matter, plus a real Back control ("just restart, and if
in the first few seconds, go back"). Full research-then-design-then-build
pass, split into seven committed chunks:

- **Dropped the Live screen entirely** (`LivePerformPage.jsx` and its nav
  entry), by direct mid-round instruction — one perform screen now, not
  two independently-maintained ones.
- **Back + a real play-history stack** (`session.history`, `goBack`/
  `jumpToSong` in `playbackControls.js`) — restart-only semantics, no
  resume ambiguity, always a plain cut like Skip.
- **The "Plan" model** (`audioEngine.js`: `_plan`, `scheduleHop`,
  `cancelPlan`, `consumePlan`) — replaced reactive "poll once a second,
  then `start(now)`" scheduling with sample-accurate future-time
  `AudioContext` scheduling, researched against MDN's Web Audio best
  practices and the "tale of two clocks" pattern rather than assumed.
  `App.jsx`'s tick loop was cut over to a purely cosmetic role: notice a
  fired plan, sync display state — never decide *when* a hop happens for
  a real deck anymore.
- **`engine.getPlaybackPosition()`** — one authoritative "what's actually
  playing right now" query, sourced from `ctx.currentTime` against the
  Plan/main-deck state, including a ctx-anchored fallback for songs with
  no uploaded master (so even a silent/demo song gets an accurate,
  jank-immune countdown instead of a wall-clock guess).
- **`usePlaybackFrame`** — a `requestAnimationFrame` hook reading that
  query every frame and writing straight to refs/DOM, matching the
  already-correct `LiveWaveform` pattern. Wired into the bottom scrub bar
  (`Playhead`, rewritten off React state onto refs) and the graph's
  per-socket `CountdownRing` — both now move smoothly every frame instead
  of stepping once a second. The `node-position` elapsed/duration text was
  deliberately left on the 1Hz value; a text counter ticking once a second
  reads as normal, unlike a bar or ring visibly stepping.
- **A real bug found via this rewrite, not assumed away**: scrubbing a
  song with no uploaded master updated `session.timeLeft` directly, but
  `seekMain`/`getMainElapsed` only recognized real ('main'-kind) decks —
  so the seek never touched the engine's own ctx anchor, and the tick's
  reactive fallback (still keyed off `session.timeLeft`) could race in and
  overwrite the seek with a stale value before React's own state caught
  up. Fixed by extending both to treat a silent deck's ctx anchor the same
  authoritative way a real deck's already was.
- Every chunk verified against real Web Audio behavior via Playwright
  (synthetic audio, monkey-patched `AudioBufferSourceNode.start`/`stop`
  call recording, real playback timing samples across consecutive
  animation frames) — not just code review — before being committed to
  `main`. Full design writeup and status: `docs/playback-model.md` §6–7.

### Done this pass (round 5 — color match, right-click menus, a real live-playback bug, graph-only UI)
Fixed a serious, real live-playback bug the user caught by ear: an
outro-ending hop (either the graph's own wiring or "End set → Outro") used
to let the main song play its *entire* recorded duration before the outro
clip started — `transitionTriggerElapsed` (core.js) only special-cased
`mode === 'transition'`, never an outro ending, so it fell back to the
full song length instead of the outro edge's own `outSeconds`. Since an
outro clip is uploaded with the song's own tail still attached (so
detection can find the splice), starting it from its own beginning *after*
the main song had already played that same material out loud meant the
overlapping tail played twice before the outro's actually-new content ever
arrived — exactly the "broken audio" the user reported. Fixed by giving
outro-ending hops their own `edgeId` (`playlistNextHop`, `confirmEndSet`)
so the trigger can look up the *specific selected* outro variant's real
cue point the same way a transition already does; `performAdvance`
(`audioEngine.js`) also now prefers that same edgeId over a blind
"first outro on this song" scan, which had the added latent bug of
possibly playing the wrong variant when a song has more than one outro.
Verified directly: forcing an early `outSeconds` and watching the real
session clock hand off well before the song's recorded duration, for both
a wired graph ending and a manually-confirmed "End set → Outro".

Also this pass: **color match** — a song with cover art now tints its
playing/next/later states to that art's own dominant color (graph node,
the — since removed, see below — playing card) instead of the fixed accent
blue, muting toward that same color for one-jump-away nodes exactly like
the fixed blue palette already did (`dominantColor.js`, `usePalette` in
`shared.jsx`). **Right-click menus**: empty canvas → add a song at that
exact point or auto-arrange; a song node → focus/set-as-Start/disconnect-
all-wires/edit-in-library/delete; Start/End nodes → disconnect, disabled
when unwired. Surfaced and fixed a real pre-existing crash along the way:
deleting a song while its node was mounted threw reading `.x` off
`undefined`, because GraphPane's per-render node-refresh effect and its
separate structural-rebuild effect both fire on the same commit when
`songs` changes, in declaration order — the refresh effect ran first and
tried to rebuild a node whose song no longer existed. Also added
`disconnectAllWires` (core.js), mashup tagging (`mashupOf` on a song,
edited in Library), and `occludedTransitions` (core.js) — a long outro/
intro variant's own cue point can make an existing transition off the same
song unreachable if that variant is ever chosen, now surfaced as a warning
in Add Audio and the Library drawer.

**Removed from the Perform page (components kept, not deleted): the
sequence side panel and the bottom queue bar.** Explicit user request, so
live-set behavior — starting, ending, stopping, wiring, disconnecting —
can be exercised and verified through the graph and its toolbar/context
menus alone, rather than two parallel interfaces that could drift apart
(exactly what happened with the outro bug above: the graph's own wiring
and the panel's "End set" both routed through the same broken function, so
having two surfaces didn't actually catch it any faster). `SequencePane.jsx`
and `QueueBar.jsx` are untouched otherwise and still fully wired to accept
their old props, in case this needs to come back — some of what they did
(playhead scrubbing, the live crossfade %, the Transition/Cut/Outro next-
mode toggle, the manual Next-candidate list) has no graph-native
replacement yet.

### Done this pass (round 4 — Perform live-experience redesign)
A direct user request to simplify the live mental model, implemented in
full: (1) the Playing card's old 2-way "How it ends" (Cut/Outro) toggle is
now a 3-way **Transition / Cut / Outro** toggle that alone decides what
the Next list offers — Transition mode shows only built transitions (each
produced transition is its own card); Cut/Outro mode shows every other
song in the library, auto-starting via its intro edge when one exists.
The old per-row Cut/Transition toggle on Next rows is gone entirely — one
mode, one place it's chosen, no more "which cut is this" confusion.
(2) Clicking a Next card commits it immediately — no more stage-then-
"Set X as Next"-button two-step. (3) Next is one flat scrollable list of
larger cards, no nested sub-lists; a transition's destination song is
shown underneath its label, with a real countdown/drain bar and numeric
cue time; a cut/outro card leads with the destination song and its own
numeric length. "Later" is now a hover-only preview (not a staged plan)
of what picking a given card would lead to. (4) End Set is gone from the
list — reachable only from a low-key "End set…" link on the Playing card
or the graph's End node, both routing through a real `ConfirmModal`
(`shared.jsx`) with its own Cut/Outro pick. (5) The Playing node on the
graph canvas now shows live numeric elapsed/total time, matching what the
side panel's Playing card already showed. (6) "Next song →" is now an
icon-only skip button.
Under the hood: `session.endingChoice` ('cut'|'outro') became
`session.nextMode` ('transition'|'cut'|'outro'), persisting across a set
instead of resetting every song (an outro auto-falls back to cut if the
new Now Playing has none). `core.js` gained `transitionCandidates`/
`cutCandidates` (the two candidate-list builders, shared between the real
Next list and the hover preview) and `queueTailId` (replacing
`computeReachability`, whose `tier1` output is no longer needed now that
candidates are computed directly); `oneHopReachable` was removed as dead
code once staging went away. The graph's node hover-card collapsed from a
two-step Stage/Confirm + mode toggle to one "Set as next" button, calling
the same commit path the side panel cards use. Autoplay's own
Settings-page "Transition-only" toggle is intentionally untouched — it
governs autoplay's unattended dead-end fallback, a different concern from
the manual Next list's new mode toggle, even though the two are easy to
conflate by name.
Verified end-to-end with Playwright against the real dev server: multiple
transition cards per song pair, immediate commit on click, mode switching
changing the list contents, the End Set modal from both entry points
(link and graph node), and the graph node's live numeric position.

**Follow-up in the same pass**: a Next-list card's built audio (a
transition's fragment, or a cut/outro candidate's intro) can now be
previewed before committing — a small round play/pause button on the
card, self-contained (`PreviewButton` in `SequencePane.jsx`), that stops
its click from reaching the card underneath it so listening never doubles
as a commit. Library already had this for every built edge via its own
`<audio controls>` in the song drawer, so this closes the one place that
didn't: Perform's Next list. Verified with Playwright (real WAV data
URIs): clicking preview plays audio and leaves the queue untouched;
present on both a transition card and an intro-carrying cut/outro card.

### Done this pass (round 3 — multi-transition picker, mixing-into, finished + verified)
Answers the user's three questions: (1) multiple produced transitions
between the same two songs are now all usable, not just the first found;
(2) the Playing card shows a Spotify-style "Mixing into" block (art, title,
artist, crossfade %) once within `CROSSFADE_LOOKAHEAD_SEC` of a committed
transition's real cue point; (3) every Next/Later row now has a countdown
drain bar. Picking up round 2's in-progress handoff and finishing it:
- Added the CSS that was missing for `.seq-transition-item` and friends
  (`.seq-row-transitions`, `-dot`, `-label`, `-cue`, `.seq-row-more`,
  `.seq-mixing-pct`) — indented rows with a muted dot, an accent-tinted
  active state, and a link-style "See N more"/"Show less" toggle.
- `GraphPane.jsx`: multiple transition edges between the same two nodes no
  longer overlap into what looks like one line. A `pathOptions.curvature`
  tweak on the default bezier turned out not to work — React Flow's
  Right/Left handle positions keep both bezier control points at the same
  y as their endpoint, so two nodes at the same height stay a dead-straight
  overlapping line no matter the curvature value. Replaced with a custom
  `fanned` edge type (`fannedBezierPath` in `GraphPane.jsx`) that adds a
  real perpendicular offset to both control points — separates duplicate
  edges regardless of the two nodes' relative layout.
- Verified with a Playwright script driving the real dev server (seeded
  `localStorage` directly with two songs and two transitions between them,
  no demo data touches the shipped app): confirmed the multi-transition
  picker, expand/collapse, the drain bars, the now-visibly-fanned graph
  edges, and the "Mixing into" block appearing at the right crossfade %.
  Screenshots aren't kept in the repo — this was a one-off manual
  verification pass, easy to redo the same way for the next UI change.
- Verification caught and fixed a real bug along the way: Later-list rows
  crashed their countdown to `NaN:NaN` because `laterRows` (unlike
  `nextRows`) never computed a `secondsLeft`/`basisSec` — `SequencePane.jsx`
  now only renders the countdown span when `secondsLeft` is actually set.

### Easy
- [x] ~~Replace native `window.confirm(...)` dialogs~~ — done: song delete
      and edge remove in `Library.jsx` now use the same inline
      confirm/cancel pattern as "Clear all data" in Settings.
- [x] ~~Swap italic `.hint-text` styling~~ — done, and applied the same fix
      to `.empty-note`, `.empty-note-sm`, and `.seq-empty` for consistency
      (all four had the same italic-text issue).
- [x] ~~Add a real favicon~~ — done: `src/assets/favicon.svg`, a small
      monochrome mark echoing the app's own Playing (solid)/Next (outlined)
      node treatment.
- [x] ~~Basic keyboard shortcuts~~ — done in `PerformPage.jsx`: `/` or
      `Cmd/Ctrl+K` focuses search, arrow keys step results while search is
      active, `Space` toggles Playing — all skipped while typing in a text
      field. Verified with a Playwright pass against the real dev server.
- [x] ~~Toolbar button tooltips~~ — done: a `[data-tooltip]` CSS utility
      (dark chip, small delay) now used app-wide, starting with `Focus
      active`/`Arrange for me`. Placed below rather than above the trigger
      since the toolbar sits at the very top of the page — above would
      clip against the viewport edge (confirmed by screenshot, then fixed).
- [x] ~~Inline progress indicator for Add Audio~~ — done: a small CSS
      spinner (`.spinner`) next to the "Analyzing…" text.

### Medium
- [x] ~~Real cover art.~~ — done: `AlbumArt` (`shared.jsx`) renders a real
      `<img>` when a song has `coverUrl`, falling back to the same
      placeholder swatch otherwise; wired through all 9 call sites (graph
      nodes, Library rows, Sequence pane, queue bar, song picker). A new
      `CoverPicker` component + `core.js`'s `uploadCoverIfPossible` let you
      set one from Upload Song or Library's edit drawer — same worker path
      as audio when R2 is configured, but unlike a full master a small
      cover is cheap enough to fall back to a local data URL otherwise, so
      this works with zero backend setup instead of staying a placeholder
      until R2 is wired up. Verified end-to-end with Playwright: pick a
      cover on Upload Song → shows in the preview → shows as a real image
      in both Library and the graph node after saving.
- [x] ~~One-level undo~~ — done: `App.jsx` now snapshots songs/edges/
      session right before a delete, deletes immediately (no confirm), and
      shows a `.toast` with an "Undo" action for 6s that restores the
      snapshot wholesale. Library's delete/remove buttons act immediately
      again — the inline confirm added earlier this pass is gone, since
      the toast is the whole point of this item. Verified end-to-end with
      Playwright (delete → row gone + toast shown → Undo → row and its
      edges back, cascade-deleted edges included).
- [x] ~~Guided first-run example.~~ — done: "Load an example graph" on
      both empty states (Perform, Library) populates the small 5-song demo
      graph (repurposed from `core.js`'s previously-unused
      `sampleSongsForTests`/`sampleEdgesForTests`), and a persistent
      `.demo-banner` ("You're viewing an example graph… Start your own")
      shows the whole time it's active. Never mixes with a real library:
      `App.jsx`'s `addSong` clears the example first the moment a real
      song is uploaded, so nothing gets blended in regardless of when that
      happens. Verified end-to-end with Playwright: empty state → load
      example → 5 songs/7 pieces + banner → upload a real song → demo
      wiped, banner gone, exactly the 1 real song remains.
- [x] ~~Mid-path breadcrumb removal.~~ — done: `core.js`'s new
      `removeQueueItem(queue, index, nowPlayingId, visibleEdges)` removes
      one hop and recomputes the seam right after it against its new
      predecessor (a built transition if one exists between them,
      otherwise a cut) instead of losing the rest of the plan. The queue
      bar's existing "✕" (rename in effect: "remove from here on", still
      a full truncate) now sits next to a new "−" ("skip just this song"),
      shown only when something is actually queued after that item — both
      get the app's `[data-tooltip]` treatment, flipped above the chip via
      a new `[data-tooltip-above]` modifier since the queue bar sits at
      the bottom of the page. Verified with a standalone test of the pure
      function (5 cases: mid removal with/without a direct edge to fall
      back on, removing the last item, an out-of-range index, and removing
      right before an End Set item) and end-to-end with Playwright driving
      the real queue.
- [x] ~~Progress feedback for Add Audio detection~~ — done:
      `detectMatch` (`audioDetect.js`) takes an optional `onProgress(done,
      total)` callback fired once per reference track actually checked;
      `AddAudio.jsx` shows "Checking reference track N of M…" instead of
      one static line for the whole batch. Verified by calling the real
      `detectMatch` directly in a browser with synthetic WAV reference
      tracks (a full UI drive got unreliable in this sandbox — its network
      proxy struggles with the app's live Supabase/Google Fonts calls on
      page load, unrelated to this change).
- [x] ~~Round-5 Perform-page follow-ups~~ — done: the graph's End node is
      no longer clickable (it was the one thing on the canvas a stray
      click/drag could hit by accident) — the real trigger is now a
      deliberately loud red "End set" button in the toolbar, top-right
      near the playing/next/later legend, still gated by the same confirm
      modal; the End node itself stays as a read-only "part of your plan"
      / "not queued" indicator. The graph's per-node hover-card now offers
      the same three-way Transition/Cut/Outro choice as the Playing
      card's toggle, scoped to that one hovered song and independent of
      whatever the Playing card is currently set to — each option commits
      immediately and is disabled (with a tooltip explaining why) when
      it's not actually reachable from here. The Outro toggle (Playing
      card and hover-card both) now explains itself with a tooltip
      ("No outro produced for this song") instead of just going grey with
      no context. The Next list's countdown drain bar was real but
      essentially invisible (a 7%-opacity black wash) — now an accent-
      colored fill anyone can actually see draining. A transition
      candidate whose cue point has passed (it can't cleanly start
      anymore — its audio was built to begin exactly at that timecode)
      now drops out of the Next list instead of sitting at a dead "0:00";
      if that card had keyboard focus, focus follows to whatever now
      sits in its old slot rather than vanishing into the document body.
      Verified in a real browser: the toolbar button is present and red
      and opens the confirm modal; the drain bar's computed background/
      opacity confirm it now reads as a real progress fill; the hover-card
      renders all three options with Outro correctly disabled when there's
      no outro edge; both the Next-list card commit and the hover-card's
      direct Cut commit land the right queue entry.
- [x] ~~Final UI/UX pass~~ — done: a systematic screenshot audit of every
      page in both themes (empty/populated/started/hover/modal states,
      plus a narrower viewport), grounded in researched common failure
      modes — generic misalignment/clipping/inconsistency pitfalls, and
      the specific "looks AI-generated" tells (gradients, glassmorphism,
      generic card grids) this app's existing flat/brutalist design
      already avoids by construction. Found and fixed real bugs, and — as
      important — several suspected ones that verification (computed
      styles, not just eyeballing screenshots) proved were *not* bugs,
      so nothing got "fixed" that wasn't broken:
      - The graph canvas never fit its own content — nodes placed further
        out (a wider layout, or dagre's auto-arrange) could sit half
        outside the visible pane with no indication there was more to
        see, mid-word-clipped against the Sequence pane's edge. Added
        `fitView`/`fitViewOptions` to the initial render and a refit on
        switching to auto-arrange.
      - React Flow's own internal theme class was hardcoded to "light"
        regardless of the app's dark mode (harmless today since our own
        CSS overrides everything currently visible, but latent — any
        future built-in subcomponent, like Controls or MiniMap, would
        silently render with light-mode chrome). Wired `colorMode` to the
        same `isDark` the rest of the canvas already uses.
      - `.btn-danger` had no actual danger styling — a transparent outline
        button, barely distinguishable from Cancel next to it, used for
        "Delete song," "Clear all data," and the new End Set confirm.
        Given real weight: solid red, white text, the same fixed red as
        the toolbar's End Set button (a genuinely destructive action
        should never look like a routine secondary one).
      - Settings' Light/System/Dark toggle could clip its own "Dark"
        label — the label+control row let the control shrink along with
        its sibling text instead of protecting the control's readable
        width. Fixed the flex rule generically (`.settings-row`'s last
        child never shrinks) rather than just this one instance.
      - Add Audio's empty state ("add a song first") was the only one of
        three empty states in the app with no actual way forward — no
        Upload/Load-example buttons the other two already have. Brought
        it in line.
      Ruled out, after checking computed styles rather than trusting a
      screenshot's small-text color at a glance (four separate times):
      the graph hover-card's background in dark mode, the Library tags'
      colors, keyboard focus rings, and the disabled Outro toggle's
      tooltip — all were already correct; screenshots of small dark-on-
      dark or light-on-light UI are genuinely easy to misread, and this
      pass's actual process (verify before "fixing") is as much the
      point as its findings.

### Hard
- [x] ~~Real playback (Web Audio API)~~ — done, as a new `src/audioEngine.js`
      that layers underneath the existing session/queue model rather than
      replacing it: the session still decides *that* a hop happens (a
      committed transition's cue point, a manual skip, a dead end); the
      engine only performs the real audio side of it. Now Playing's own
      uploaded master actually plays through an `AudioBufferSourceNode`;
      at a hop, any produced fragment involved (a transition's own
      recorded clip, an outro leaving the old song, an intro starting the
      new one) plays to its natural end first, then the destination's own
      master becomes the new "main" deck — a transition's clip is what
      carries the actual crossfade, splicing back into the destination at
      its recorded `inSeconds`; a plain cut/outro always starts its
      destination from 0. Pausing suspends the whole `AudioContext`
      (freezes whatever's sounding, fragment or main deck) rather than
      tracking play/pause per node, so resume always continues exactly
      where it left off.
      Graceful per-song degradation, not a hard requirement that every
      song has audio: `engine.getMainElapsed(songId)` returns null
      whenever that song isn't genuinely sounding right now, and the set
      clock (`App.jsx`) falls back to a wall-clock estimate for that song
      — real audio and "still just planned" can sit side by side in the
      same set. The set-clock's timer and the manual skip button now both
      go through one shared `performAdvance` (`audioEngine.js`) so they
      can never disagree about what a hop actually does.
      Fixed a real regression caught during verification, not just in the
      new code: tightening the set-clock's tick to 200ms (for a smoother
      real-audio countdown) meant every tick produced a new session object
      faster than the save effect's 400ms debounce could ever fire —
      autosave would have silently stopped working for the entire
      duration of any playing set. Reverted to the original 1000ms
      cadence (still computed from real elapsed time, not a fixed "-1 per
      tick", so accuracy didn't regress) rather than touching the
      debounce itself.
      Verified in a real browser (not mocked) with synthetic WAV audio for
      two songs plus a produced transition clip between them: Song A's
      real `AudioContext` clock is confirmed running and advancing at
      real wall-clock speed; committing the transition and waiting past
      its cue point shows the transition clip playing through, then
      Song B's own master becomes the real main deck at its `inSeconds`
      cue; clicking Pause suspends the context and the real elapsed time
      genuinely stops advancing (confirmed unchanged after a further
      1.2s wait); clicking Play resumes it and elapsed continues forward
      from exactly where it paused.
- [x] ~~Range-fetch based detection.~~ — done, for the case it can be done
      correctly: `audioDetect.js`'s new `fetchEdgesRanged(url)` gets a
      plain-PCM WAV reference's exact duration (from its header, not a
      decoded buffer) plus head/tail RMS envelopes via one small probe GET
      and up to two small Range GETs — no worker changes needed, since
      public bucket reads already bypass the worker straight to R2, which
      answers Range requests natively (just needs `Range` in the bucket's
      CORS `AllowedHeaders`, already covered by the `"*"` in the README's
      recommended policy). Walks the WAV's actual RIFF chunks rather than
      assuming a fixed 44-byte header, since a DAW export can carry extra
      metadata chunks first. Deliberately scoped to WAV/PCM only — AIFF/
      FLAC/MP3 references still get the old full-file `fetchAndDecode`
      path, because safely reconstructing a decodable partial file from an
      arbitrary byte range isn't tractable for those formats without a
      real format parser; `detectMatch` falls back to it automatically
      whenever the ranged path returns null (not a WAV, not PCM, or a
      header that didn't fit the probe).
      Verified against a local HTTP server with real Range support (206
      Partial Content): the ranged head/tail envelopes and duration are
      byte-identical to a full decode's, including for a WAV with an
      injected `LIST` metadata chunk before its data (proves the chunk
      walker); the full `detectMatch` pipeline correctly identifies both
      sides of a constructed transition with the right cue timecodes;
      exactly 3 small range requests are made (all 206s) totaling no more
      than the file's own size, not one download per candidate; and a
      non-PCM WAV (audioFormat ≠ 1) correctly returns null to trigger the
      fallback.
- [x] ~~Real audio duration + BPM/key from analysis~~ — done, as a small
      dependency-free DSP module (`src/audioAnalyze.js`) rather than pulling
      in Essentia.js/WASM: duration comes straight off the decoded
      `AudioBuffer` (exact, not `mockDuration`'s guess); BPM comes from
      autocorrelating a frame-energy onset-strength envelope over the lag
      range for 70-190 BPM (a standard, cheap beat-tracking approach); key
      comes from a 12-bin chroma vector — built with the Goertzel algorithm
      (a targeted single-frequency DFT bin, far cheaper than a full FFT
      when only ~56 note frequencies across ~30s of audio are needed) —
      correlated against the Krumhansl-Kessler major/minor key profiles at
      all 12 rotations.
      Wired into Upload Song: dropping a file kicks off `analyzeAudio` in
      the background (with its own "Analyzing…" spinner, same visual
      language as Add Audio's), then fills BPM/Key only if the DJ hasn't
      already typed something in — same "detected but editable" contract
      as Add Audio's transition detection — and a "Detected Ns, N BPM, key
      — edit above if it's off" summary line confirms what was found.
      Verified two ways: (1) a synthetic WAV built from a 128 BPM click
      track plus a sustained A-minor chord, fed straight to `analyzeAudio`
      in a real browser (not jsdom — needs real `decodeAudioData`), came
      back with exact duration, BPM within 1.2 of true, and the correct
      key; (2) the same file dropped through the actual Upload Song form
      in Playwright auto-filled BPM/Key from empty, showed the detected
      summary, and the saved song in `localStorage` carried the real
      duration/BPM/key end to end.
- [x] ~~Dark mode~~ — done, as a genuine second token set, not a filter/
      invert: `styles.css`'s `:root` still holds the light palette;
      designed dark values override it via `@media (prefers-color-scheme:
      dark)` (the default "System" behavior) and an explicit
      `[data-theme]` attribute that always wins either direction — set by
      a new Light/System/Dark toggle in Settings → Appearance, persisted
      to `localStorage` via `src/theme.js` (a device preference, not
      synced through the app's own JSON blob, same as the OS's own
      dark-mode switch isn't part of your music library).
      The real work (and why a blanket token flip would've broken things)
      was sorting components into two groups: most of the app — page bg,
      text, panels, borders, buttons, the brutalist tags (already just
      `border/color: var(--ink)`, so they came along for free once --ink
      itself got a real dark-mode value) — correctly want `--ink`/
      `--paper`/`--panel`/etc. to flip together. But a few components are
      already "inverted" by construction regardless of page theme — the
      Playing card's fixed navy (`--state-playing`) with light text, the
      toast/lib-select-bar/active-nav's ink-background chips — and reusing
      the now-adaptive `--paper` for text on that fixed navy would have
      gone dark-on-dark. Split those into a `--paper-fixed` token (always
      light, for the Playing-card family) and a new `--accent-text` token
      distinct from `--accent-ink` (the latter stays fixed-dark for text
      *on* the light `--accent` swatch itself — btn-accent, pill.active —
      while `--accent-text` adapts for accent-colored text sitting on the
      page or on `--accent-bg`, like the demo banner and cover-picker
      label). React Flow's edge strokes and canvas dot-grid are literal
      SVG/canvas paint, not CSS, so they can't read custom properties —
      `GraphPane.jsx` now picks a light/dark literal itself via the new
      `useTheme()` hook, with real designed dark values rather than the
      same light-tuned ones (which would've been jarringly bright against
      a dark canvas).
      Caught and fixed a real pre-existing contrast bug along the way,
      unrelated to dark mode itself but found while auditing every
      state-playing context: the Playing card's BPM/key tags were using a
      dead `.seq-now .tag` selector (the real class is `.seq-now-card`),
      so they'd silently fallen back to default `.tag` styling — dark ink
      text/border directly on the dark navy card, always low-contrast even
      in light mode. Fixed the selector.
      Verified with Playwright across both the explicit `[data-theme]`
      path and the pure OS-driven `prefers-color-scheme` path (no override
      set): Perform (Playing card, tags, fanned graph edges, dot grid),
      the End Set confirm modal, Library, and the undo toast all render
      with real, legible, designed dark values — and a light-mode
      screenshot taken after all these changes is pixel-equivalent to
      before them, confirming zero regression to the default theme.
- [x] ~~Accessibility pass~~ — done, scoped exactly to the suggestion
      here: a real list-based fallback for the graph, not tab-index
      patches on a spatial canvas that was never going to be keyboard-
      navigable on its own terms. The round-4 redesign already put a flat,
      list-based Next picker in the side panel as the primary way to
      choose what plays next — this pass made it a genuinely accessible
      one: `SequencePane.jsx`'s Next/Later cards are real `<button>`
      elements now (were a `<div onClick>`, invisible to Tab and unusable
      without a mouse), each with a computed `aria-label` describing what
      it leads to; focusing one with the keyboard fires the same
      `onMouseEnter` a mouse hover would, so Tabbing through the list
      previews the Later list and highlights the graph exactly the way
      hovering does — a keyboard-only pass gets the same information a
      sighted mouse user does, not a degraded one.
      Also: a site-wide `:focus-visible` ring (keyboard/AT navigation
      only, never a mouse click) on every interactive element; the End Set
      `ConfirmModal` (`shared.jsx`) is a real `role="dialog"` with
      `aria-modal`/`aria-labelledby`, focuses its Cancel button on open
      (the safer default action), and closes on Escape; every icon-only
      button that had no visible text (skip, play/pause, the audio preview
      toggle, search's prev/next match, the queue chip's skip/remove) got
      a real `aria-label` — `data-tooltip` reads fine on hover but isn't
      exposed to assistive tech at all; and the segmented Transition/Cut/
      Outro and Cut/Intro toggles gained `aria-pressed` so a screen reader
      announces which one is currently selected. The graph canvas itself
      stays a visual planning surface — the design decision here is that
      it doesn't need its own parallel a11y story once the thing it drives
      (the Next list) is a fully keyboard-operable substitute.
      Verified with Playwright, keyboard-only (no mouse events at all):
      Tab from the skip button lands on a Next card with a real
      `aria-label`, pressing Enter commits it exactly like a click would,
      the visible focus ring renders correctly, and Escape closes the End
      Set modal after it auto-focused Cancel.
- [x] ~~Code-split the bundle.~~ — done: all five pages are `React.lazy`
      in `App.jsx` now, each downloading only once its tab opens.
      `ReactFlowProvider` moved from `App.jsx` into `PerformPage.jsx`
      itself (wrapping a new inner component) so `@xyflow/react` doesn't
      leak into the main chunk via App's own imports. Main chunk: 703KB →
      374KB (210KB → 107KB gzip); Perform's own chunk (React Flow + dagre
      + Fuse.js) is 307KB (98KB gzip), Library/Upload/Settings/Add Audio
      are 2-8KB each. Supabase (~part of the main chunk) is left as-is —
      it's read synchronously at boot (`isSyncConfigured`) for the
      always-attempted sync, so deferring it would need a larger, riskier
      restructure for a smaller win than Perform's split. Verified by
      building (chunk sizes above) and navigating all five tabs with
      Playwright — no runtime errors, every page still renders.
- [x] ~~Autoplay / infinite set mode~~ — done round 2: `pickAutoplayNext`
      (random among built transitions, falls back to a random cut unless
      Transition-only is on) plus `graphEstimate.js`'s SCC-based closed-loop
      detection, both wired into the Sequence pane. Weighting the random
      pick against recently-repeated songs is still open if the plain
      random policy feels too repetitive in practice.

## Desktop packaging

**Tauri, not Electron.** Wraps the existing React UI in the OS's native
webview instead of bundling Chromium — roughly 3-10MB installers and
25-40MB idle RAM versus Electron's 100MB+/150-300MB. The move to a real
Vite build this pass makes this *more* straightforward than before, not
less — Tauri wraps a Vite app natively.

**Audio engine: Web Audio API, not a native audio framework** — this
product's differentiator is the graph/planning layer, not scratch-DJ
latency, and Web Audio's scheduling is what the real-playback and
Essentia.js work above already need anyway.

**Before shipping, budget for:** Apple Developer Program ($99/yr, macOS
notarization), Windows code signing via Azure Trusted Signing (~$10/mo,
cheaper than a traditional EV cert), Tauri's built-in signed-updater
plugin.

## Business model

- **"Rent to own,"** not a flat subscription and not a flat one-time
  price: billed monthly, customer picks their own amount with a **$5
  minimum**, payments accumulate toward a full price (e.g. $79); once
  reached, billing stops and the license unlocks permanently. Low-friction
  trial ($5 first month), no resentment from either open-ended billing or
  a large upfront ask.
  - Needs custom billing logic on top of whatever processor you pick
    (Stripe Checkout supports customer-adjustable amounts; your own
    backend tracks cumulative-paid and cancels the recurring charge once
    the threshold crosses). Confirm your chosen processor
    (Polar/Creem/Paddle/Stripe) actually supports customer-adjustable
    recurring amounts before committing.
  - Keep the $5 floor as the headline pitch in marketing, not the $79
    payoff number.
  - Cloud-sync add-on ($3-5/mo) stays separate and keeps billing after the
    core app is paid off — it's an ongoing Supabase/R2 cost, not part of
    the purchase price.
  - Anchor: Mixed In Key (~$58-99) sits below this product's actual scope;
    full DJ software ($250-500+) is a different category, not the
    comparison to make.
- **Payment processor**: a Merchant of Record (Polar or Creem look like
  the best fit for a solo dev) *if* it supports customer-adjustable
  recurring amounts — verify before committing. Avoid betting on
  LemonSqueezy long-term (Stripe acquired it in 2024).

## Design system

- Monochrome paper/ink/panel base, one accent (`--accent: #8b7bb8`, a
  dusty pastel purple) spent only on interactive/active state — kept this
  pass; you gave permission to drop it for something more Apple-plain if
  needed, but the current read (after the highlight-state redesign) feels
  restrained rather than loud, so it stayed. Worth revisiting once real
  cover art is in the picture, since art will carry more visual weight
  than the accent color does today.
- **Wordmark**: Gnomon\* Foreground (indestructible type\*, OFL-1.1),
  self-hosted as `src/assets/gnomon.woff2` — compiled from
  `github.com/indestructible-type/Gnomon`'s UFO source with `fontmake`
  since the repo only ships a prebuilt copy of the variable *shadow*
  layer, not the bold display letterforms. Wordmark use only.
- **Body type**: Jost (indestructible type's own font, loaded from Google
  Fonts), heavier default weight and darker secondary grays than the very
  first pass, which read as thin/washed-out.
- **Data tags** stay brutalist — bordered monospace boxes, no fill, no
  per-category color; the label text carries the meaning.
- Tight 2px radius, hairline borders; depth from paper/panel/ink value
  steps rather than shadows (shadows reserved for genuinely floating
  elements — the hover-card, search suggestions).
