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
- **Next** — reachable-now candidates (the graph's purple-outlined nodes,
  the Sequence pane's first list); once one is armed it's the thing that
  will actually play after Playing.
- **Later** — what's reachable *after* whatever's staged in Next — a
  two-move lookahead, not an open chain.
- **Cut** — a hard edge with no fragment.

## Graph model — decided, don't revisit

Single node per song, directed edges between them. A remix is its own
song/node, not a sub-version. Loop-back edges get routed as curved arcs by
dagre automatically now (in Auto-arrange mode) — in Manual mode edges are
still React Flow's default smooth bezier, just following straight-line
node placement, since dagre isn't computing bends for a layout you're
controlling by hand.

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

## Your tasks (only you can do these — accounts, keys, hosting)

1. **GitHub Pages**: Settings → Pages → Source: "GitHub Actions". The
   updated workflow builds with `npm ci && npm run build` and deploys
   `dist/` — next push to `main` gets you a live URL, no backend required.
2. **Supabase — already live.** I found a Supabase project named "eskimo"
   already on your account and used it: applied `supabase/schema.sql`
   (one RLS-scoped `library` table) via the Supabase MCP connection, and
   `src/config.js` already has that project's real URL + anon publishable
   key. The one thing I *can't* do through that connection is flip the
   Auth provider toggle — **Authentication → Providers → enable Anonymous
   Sign-Ins** on that project (there's no login screen yet, so anonymous
   auth is what gives each browser a stable identity to sync under). Sync
   silently no-ops until that's on.
3. **Cloudflare R2** (for audio storage — this is what unlocks real
   detection + reference downloads for everyone, not just locally):
   - Create a bucket: `npx wrangler r2 bucket create eskimo-studio-audio`
     (name matches `worker/wrangler.toml`).
   - Bucket → Settings → **Public access** → turn on (the free `r2.dev`
     subdomain is fine to start) → put that URL into `wrangler.toml`'s
     `PUBLIC_BUCKET_URL`.
   - **CORS** — you asked about this, and yes, it's needed twice, for two
     different things:
     - *The bucket itself* needs a CORS policy so the browser can `fetch()`
       reference audio directly (for detection, and for the download
       button) from a different origin (your Pages site) than the bucket's
       own. In the R2 bucket's Settings → CORS Policy, add:
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
       (Tighten `AllowedOrigins` to your actual `https://<you>.github.io`
       once you have that URL.)
     - *The worker* (`worker/upload-worker.js`) already sets its own CORS
       response headers for the `/upload` endpoint — that's a separate
       concern from the bucket's CORS above (one governs uploads through
       the worker, the other governs direct reads from the bucket).
   - Deploy: `cd worker && npx wrangler login && npx wrangler deploy` →
     copy the `*.workers.dev` URL into `src/config.js`'s
     `UPLOAD_WORKER_URL` (or a repo secret, see the workflow file).
4. Tell me once the above is done (or hand me anything you'd rather I
   didn't do myself) and I'll verify sync + upload + detection end-to-end
   against the real thing instead of just the local build.

## My tasks — Easy / Medium / Hard

Everything below came out of actually looking at this with an eye toward
"would this read as sleek, minimalist, and obvious to someone who's never
seen it" — the standard you asked for, benchmarked against the kind of
apps this one takes inspiration from.

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

### Hard
- [ ] **Real playback (Web Audio API)** — actual scheduled crossfades,
      not just planning. This is the biggest remaining "does it actually
      DJ" gap and touches audio engine, timing/scheduling, and the whole
      Sequence pane's countdown semantics (which are currently a mocked
      `durationSec`, not read from real audio).
- [ ] **Range-fetch based detection.** `audioDetect.js` currently downloads
      each candidate's *entire* reference file to correlate ~10 seconds of
      it — fine for a small library, real cost at scale. The fix is HTTP
      Range requests against R2 (R2 supports them) to fetch only the
      head/tail bytes needed, which also means teaching
      `worker/upload-worker.js` (or R2 directly, since public bucket reads
      don't go through the worker) to pass Range headers through cleanly.
- [ ] **Real audio duration + BPM/key from analysis** (Essentia.js,
      WebAssembly, client-side) — replaces `mockDuration` and the
      manually-entered BPM/key fields, and would make the Sequence pane's
      countdown mechanic real instead of simulated.
- [ ] **Dark mode** as a genuine second token set (not a filter/invert) —
      noted as real work in the original design pass and still true; the
      brutalist tag styling in particular needs its own dark treatment,
      not just inverted grays.
- [ ] **Accessibility pass**: keyboard navigation for a fundamentally
      spatial, mouse-driven graph canvas is a real design problem, not a
      quick fix — needs its own thought-through interaction model (e.g. a
      list-based fallback view), not just tab-index patches.
- [ ] **Code-split the bundle.** React Flow + dagre + Supabase pushed the
      single JS chunk to ~685KB — lazy-loading the Perform tab's graph
      dependencies separately from Library/Upload/Settings would cut
      initial load meaningfully for a page most sessions won't start on.
- [x] ~~Autoplay / infinite set mode~~ — done round 2: `pickAutoplayNext`
      (random among built transitions, falls back to a random cut unless
      Transition-only is on) plus `graphEstimate.js`'s SCC-based closed-loop
      detection, both wired into the Sequence pane. Weighting the random
      pick against recently-repeated songs is still open if the plain
      random policy feels too repetitive in practice.
- [ ] **"Flow" visual pass** — particles/light pulses along built edges for
      an idle ambient view and a shareable graph "signature" export.

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
