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

### In progress — finish this next (handoff notes)
Mid-session work answering the user's questions about (1) multiple produced
transitions between the same two songs, (2) what the Playing card shows
during a transition, and (3) missing countdown bars in Next. Code changes
already made and building clean (`npm run build` passes):
- `core.js`: added `CROSSFADE_LOOKAHEAD_SEC` + `transitionTriggerElapsed()`
  so the set-clock hands off at a transition's real `outSeconds` cue point
  instead of always waiting for the full song to end.
- `App.jsx`: set-clock interval now uses `transitionTriggerElapsed`.
- `PerformPage.jsx`: `optionsFor`/`stage`/`commitStaged` now track
  `stagedEdgeId` and expose the full `transitionEdges` array (via new
  `findEdges`, plural) instead of only the first match between two songs —
  this is what lets multiple produced transitions between the same pair
  both be usable. `nextRows` now carries `basisSec` (the countdown's 100%
  mark) so every Next row can render a drain bar. A `mixingIntoSong` /
  `crossfadePct` pair is computed (true once within
  `CROSSFADE_LOOKAHEAD_SEC` of a committed transition's cue point) and
  passed to `SequencePane`.
- `SequencePane.jsx`: rewritten — every Next/Later row now renders a
  `.seq-row-drain` countdown bar; rows with more than one transition edge
  show them indented under the song with labels (`edge.label` or
  "Transition N") via a new `TransitionOption`, first one visible plus a
  "See N more" expand button so a song with many transitions doesn't blow
  out the list; the Playing card now shows a Spotify-style "Mixing into"
  block (art + title + artist + crossfade %) once `mixingIntoSong` is set.
- `styles.css`: added `.seq-row-drain`, `.seq-mixing-row` and friends.

**Still needed before this is actually done:**
1. `.seq-transition-item`, `.seq-transition-dot`, `.seq-transition-label`,
   `.seq-transition-cue`, `.seq-row-more`, and `.seq-mixing-pct` are
   referenced in `SequencePane.jsx` but have **no CSS yet** — right now
   they'll render with browser-default/unstyled appearance. Add proper
   styles (small indented rows, a muted dot, a "see more" link-style
   button, contrast-checked against both the light Next-list card and the
   dark Playing card).
2. `GraphPane.jsx` still renders multiple transition edges between the
   same two graph nodes as fully overlapping lines (looks like one edge).
   Needs a per-edge curvature/offset (e.g. via React Flow's
   `pathOptions.curvature`, offset by index among duplicate source/target
   pairs) so they're visually distinguishable on the canvas too, not just
   in the Sequence pane list.
3. Rebuild and take fresh Playwright screenshots (the existing
   `scratchpad/flow.js` script from the last verification pass is a good
   base — extend it with a second transition between the same two demo
   songs) confirming: every Next row shows a countdown bar, a song with
   2+ transitions shows the indented/labeled picker with working
   expand/collapse, and the Playing card's "Mixing into" block actually
   appears near a transition's cue point during a real playthrough.
4. Re-check contrast/visibility on every new piece of UI per the
   standing rule from earlier feedback ("check to make sure every
   button/label is visible") — this has bitten this project multiple
   times via CSS specificity issues, so don't assume it's fine unstested.
5. Once verified, report back to the user directly answering their three
   original questions, tied to what's actually shipped:
   - Multiple transitions between two songs: now handled — Next-list rows
     expose all of them, not just the first found.
   - What the Playing card does mid-transition: shows both songs (a
     "Mixing into" block), Spotify-style.
   - Countdown bars: now on every Next row via `.seq-row-drain`.

### Easy
- [ ] Replace native `window.confirm(...)` dialogs (song delete, edge
      remove) with the app's own inline confirm pattern (already used for
      "Clear all data" in Settings) — a browser-native dialog box breaks
      the whole visual language the moment it appears.
- [ ] Swap italic `.hint-text` styling for regular-weight muted text —
      italics read as dated/Word-doc-like, not minimal.
- [ ] Add a real favicon/tab title treatment (currently unset).
- [ ] Basic keyboard shortcuts: `/` or `Cmd+K` focuses search, `Esc` clears
      it, arrow keys step search results, `Space` toggles play/pause on
      Playing. Small effort, outsized "this feels considered" payoff.
- [ ] Toolbar buttons (`Focus active`, `Arrange for me`) have `title`
      tooltips but no visible on-hover tooltip styling — add one
      consistent tooltip treatment app-wide.
- [ ] "Analyzing…" during Add Audio detection is plain italic text; a
      small inline progress indicator would read as far more "real work is
      happening" than static text, especially once detection is fetching
      multiple reference tracks.

### Medium
- [ ] **Real cover art.** Album art is a decorative placeholder swatch
      everywhere right now — letting a song store an actual uploaded
      thumbnail (via the same R2 worker path) would be the single biggest
      visual-polish lever left; this app's closest inspirations are all
      very art-forward.
- [ ] **One-level undo** (a toast with an "Undo" action) for song/edge
      deletion instead of a blocking confirm — feels more forgiving and
      modern than a dialog you have to stop and read.
- [ ] **Guided first-run example.** The app is correctly seed-data-free by
      design, but that means a brand-new producer friend opens it to
      nothing — a one-click "load an example graph" into an obviously-
      marked demo state (never mixed into their real library) would help
      the exact audience you're handing this to.
- [ ] Path breadcrumb in the Sequence pane can only be trimmed from the
      end (by re-staging); removing one specific mid-path step without
      clearing everything after it isn't possible yet.
- [ ] Progress feedback for Add Audio detection when checking many
      reference tracks (currently one static "Analyzing…" for the whole
      batch, with no sense of how many candidates are left).

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
