# Eskimo Studio — handoff notes

This file is the backlog and the reasoning behind it, for whoever (human or
agent) picks this up next in Claude Code.

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

## Terminology glossary — exactly three states, in this order

**Playing → Next → Later.** Standard DJ words are kept as-is (Transition,
Intro, Outro, BPM, Key, Cue); only the app's own states are simplified to
these three, used consistently in code, UI copy, and this document:

- **Playing** — the song live right now.
- **Next** — reachable-now candidates (the graph's accent-outlined nodes,
  the Sequence pane's card list); clicking one commits it immediately as
  the thing that will actually play after Playing — there's no separate
  staging step (round 4).
- **Later** — a hover-only preview (not a staged plan) of what picking a
  given Next candidate would lead to — a one-move lookahead, not an open
  chain, and nothing is committed by it.
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

1. **Data model** — `activePlaylist`/`playlists` in `core.js`, persistence,
   pure helpers (socket eligibility, connection resolution, the
   auto-commit-from-wiring tick logic).
2. **Graph visuals, read-only first** — the three arrow tiers (grey
   dotted always-on, replacing today's tiered coloring), typed sockets
   rendered (hidden when ineligible) but not yet interactive. Get this
   looking right before wiring up interaction.
3. **Socket interaction** — click-to-toggle None/Intro/Outro, drag-to-
   connect Transition sockets (with the multi-candidate popup), the
   hover-✕ disconnect, the connected-socket label + reopen behavior.
4. **Wire it into real playback** — the tick loop auto-commits from
   `activePlaylist` when nothing's manually queued; verify a built loop
   actually autoplays forever without manual clicks, same rigor as every
   other Hard-tier item in this file (real browser, real synthetic audio,
   not just visual).
5. **Countdown bars everywhere** transitions/outros show up.
6. **Save/Load playlist** — toolbar button, persisted `playlists` array,
   confirm-before-replace on load.
7. **Readonly filmstrip** replacing `QueueBar`.
8. **Zoom level-of-detail.**
9. Only after all of the above is solid: revisit whether the Sequence
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
**Status: not yet confirmed done.**
1. In the repo on GitHub: **Settings → Pages → Source → "GitHub Actions"**.
2. Push to `main` (or re-run the "Deploy to GitHub Pages" workflow from the
   Actions tab). `.github/workflows/pages.yml` already exists and does
   `npm ci && npm run build`, deploying `dist/` — nothing else to write.
3. The workflow's Actions run will show the live URL once it finishes
   (also visible under Settings → Pages afterward).

### 2. Supabase — sync your library across devices
**Status: mostly done — one toggle left.** A Supabase project named
"eskimo" is already live and wired up: `supabase/schema.sql` (one
RLS-scoped `library` table) is applied, and `src/config.js` already has
that project's real URL and anon publishable key — nothing to create or
copy here.
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
