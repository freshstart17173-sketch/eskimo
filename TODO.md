# Eskimo Studio — handoff notes

This file is the backlog and the reasoning behind it, for whoever (human or
agent) picks this up next in Claude Code. `index.html` is a complete,
working single-file build (React 18 + Babel Standalone via CDN, no build
step) — open it in a browser and it runs. Everything below is what's
*not* built yet, roughly in the order it makes sense to tackle it.

## Positioning — read this first, it shapes every decision below

This is **not** live DJ software. It is not competing with Serato /
rekordbox / VirtualDJ, and feature decisions shouldn't be benchmarked
against them. The person is a producer who makes elaborate mashups,
transitions, intros and outros in their own DAW — things that can't be
performed live, spontaneously — and this tool is where those pieces live
afterward: organized into a "master graph" of songs and the pre-built
audio that connects them, so that during a live set they can adapt in the
moment (react to the crowd, change the plan) while still getting the
benefit of studio-quality transitions they took the time to make
elsewhere. A big enough graph means any song is a click away from
anywhere else in it. Enough closed loops in the graph means the whole
thing can auto-play as an infinite seamless set.

The interface should stay minimal because the job — controlling music —
is simple; the depth lives in how much the person has built into their
graph, not in how many controls are on screen.

## Graph model — decided, don't revisit

Single node per song, directed edges between them (transitions / intros /
outros), same as it is now. This was considered and rejected: a
"one-way flow" graph where nodes repeat per path so nothing ever crosses
itself. It doesn't work as the primary model because a loop unrolled that
way is infinite — there's no node count to cap it at that isn't
arbitrary — and any song with more than one incoming and outgoing edge
would need a separate node per path through it, which blows up
combinatorially in exactly the graphs this product wants to encourage
(big, interconnected ones).

What *should* change is the **layout**, not the data model:
- Forward-flowing transitions (the common case) render as short, straight
  arrows.
- Any edge that loops back to something earlier in the current flow
  direction renders as a curved arc routed around the outside, visually
  distinct (dashed, muted color) from a forward edge — instead of a
  straight line crossing through other nodes. See the diagram shared in
  chat during the design discussion for the exact convention (5 nodes in
  a row, one dashed arc looping back under the row).
- An optional "tidy layout" auto-arrange (left-to-right or top-to-bottom
  by rough energy / BFS distance from the person's most-used opener),
  toggle-able, that never overrides manual dragging unless the person
  asks for it.

## Feature backlog

- [ ] **Real audio detection.** Replace `pickDetectedSongs` (the
      deterministic mock in `core.js`) with real analysis: **Essentia.js**
      (WebAssembly build of the Essentia C++ MIR library) runs entirely
      client-side and can detect BPM, musical key, and Camelot code
      directly from the dropped file — no server round-trip needed. This
      is what should drive Add Audio's "detected" step for real, and
      could also auto-fill BPM/key on Upload Song instead of asking for
      them.
- [ ] **Autoplay / infinite set mode.** The reachability set the graph
      already computes (`computeReachability` in `core.js` — which songs
      are validly next) is exactly the input an auto-picker needs.
      Autoplay is "pick from that set on a timer instead of waiting for a
      click." Add:
      - A policy for picking (random among built/verified edges; weighted
        to avoid repeating a song too soon).
      - Closed-loop detection: whether the current position sits in a
        strongly-connected component of verified edges, i.e. can wander
        forever without dead-ending. Surface this visually on the graph
        (e.g. a highlight over "finished circuits") so the person can see
        which parts of their graph are autoplay-safe versus still-open
        branches, and so autoplay itself only wanders inside one.
- [ ] **"Flow" visual pass on the graph canvas.** Distinct from the
      arc-for-loops layout fix above — a more organic/ambient rendering:
      particles or light pulses traveling along built edges, like signal
      flowing through a patch bay. Two uses: (1) an idle ambient view of
      the graph while performing, (2) a shareable "signature" export of a
      graph (a dense, well-built graph should look visually different
      from a sparse one) — this doubles as a natural, low-effort marketing
      hook (people showing off their graph).
- [ ] **Node CRUD polish**: bulk operations in Library (multi-select
      delete/tag), duplicate-song detection on Upload Song.

## Backend — not wired up yet, currently pure localStorage

- **Supabase**: Postgres + auth + RLS for the song/edge graph and sync
  metadata across devices.
- **Cloudflare R2** for the actual audio files. Don't put audio in
  Supabase Storage — R2's zero egress fee matters a lot here since the
  person will be repeatedly streaming/downloading their own multi-GB
  library.
- Keep a local SQLite cache (via Tauri) so the app works fully offline
  and only syncs deltas when online. The `Store` object in `core.js` is
  the one seam meant for this swap — every read/write already goes
  through it, nothing else should need to change.

## Desktop packaging

**Tauri, not Electron.** Wraps the existing React UI in the OS's native
webview instead of bundling Chromium — roughly 3-10MB installers and
25-40MB idle RAM versus Electron's 100MB+/150-300MB, and the existing
`app.jsx`/`core.js` carry over basically unchanged; Tauri just wraps them.
Electron would only make sense if deep Node-ecosystem native modules turn
out to be necessary, which they shouldn't be here (see audio below).

**Audio engine: Web Audio API, not a native audio framework.** This
product's differentiator is the graph/planning layer, not scratch-DJ
latency, so there's no need for a heavyweight native engine (JUCE etc.) —
Web Audio's sample-accurate scheduling is sufficient for crossfades and
playback, and it's what Essentia.js above needs anyway.

**Before shipping, budget for:**
- Apple Developer Program: $99/year (required for macOS notarization).
- Windows code signing: use Azure Trusted Signing (~$10/month) rather
  than a traditional EV certificate — much cheaper than the old
  $200-800/year certs with mandatory hardware dongles.
- Tauri's built-in updater plugin for signed auto-updates.

## Business model

- **"Rent to own," not a flat subscription and not a flat one-time price.**
  The person's own idea, and it's a good one for this specific
  situation: billed monthly, the person picks their own amount each month
  with a **$5 minimum** and no fixed maximum, and those payments accumulate
  toward the full price (e.g. $79). Once cumulative payments reach that
  number, billing stops automatically and the license is permanently
  unlocked — no further charges, ever. This gives a genuinely low-friction
  way to try it (pay $5 the first month), lets someone who decides it's
  not for them walk away having paid very little rather than being on the
  hook for a subscription forever, and removes the exact resentment that
  turns people toward "someone will just clone this for free" — nobody's
  being asked to pay indefinitely for something they don't use.
  - **Implementation note**: this isn't a standard fixed-price subscription
    object, so don't reach for a MoR's out-of-the-box subscription
    product as-is. The practical way to build it: a recurring charge each
    month for a customer-chosen amount (Stripe Checkout supports
    customer-adjustable amounts at checkout), with your own backend
    tracking cumulative-paid-to-date per customer and calling the
    processor's API to cancel the recurring charge once the threshold is
    crossed (and reconciling the final month if someone overshoots the
    remaining balance). This needs a bit more custom billing logic than a
    typical MoR subscription flow supports out of the box — budget real
    engineering time for it, and confirm whichever processor you land on
    (Polar/Creem/Paddle/Stripe) actually supports customer-adjustable
    recurring amounts before committing to one.
  - Keep emphasizing the $5 floor prominently in launch marketing — that's
    the actual pitch ("try it for $5") rather than the eventual payoff
    number.
  - The optional cloud-sync add-on ($3-5/month) stays separate from this
    payoff mechanic — it's an ongoing service cost (Supabase + R2 usage),
    not part of the software's purchase price, so it keeps billing even
    after the core app is paid off.
  - Anchor for the eventual payoff total: Mixed In Key (~$58-99, closest
    comparable single-purpose tool DJs already trust) sits below this
    product's actual scope (persistent library + live-adaptive performance
    + auto-detection), while full DJ software ($250-500 or subscription)
    is a different category entirely — not the comparison to make. $79
    is a reasonable target.
- **Payment processor**: a Merchant of Record (handles global tax/VAT
  automatically) — Polar or Creem are the current best fits for a solo
  dev (lower fees than Paddle, more indie-focused than Gumroad), *if*
  they support the customer-adjustable recurring amount this billing
  model needs (verify before committing). Avoid betting long-term on
  LemonSqueezy; Stripe acquired it in 2024 and its roadmap now sits
  inside Stripe's own merchant-of-record product.

## Design system

Already implemented in `styles.css` — documented here so the reasoning
isn't lost in a later pass:

- Light, monochrome base (paper/ink/panel/line grays) — this is the
  original "eski" look and it's staying; this pass was layout/spacing
  tightening (denser paddings, consistent gap scale, tighter radius), not
  a re-theme. If a future pass considers dark mode, that's a real second
  token set, not a tweak of this one.
- **One accent color**: a dusty pastel purple (`--accent: #8b7bb8`),
  spent only on interactive/active state — active nav item, primary
  "confirm" actions, the now-playing/reachable highlight on the graph,
  focus rings, progress fill. Never on static data.
- **Data tags (BPM, key, dead-end, remix) are brutalist, not SaaS pills**:
  plain bordered boxes (`border-radius: 0`), monospace type, no fill, no
  per-category color — every tag is just ink-on-transparent with a
  hairline border. The label text carries the meaning ("128 BPM", "A
  min", "dead end"); color doesn't need to repeat it. This was a direct
  correction from an earlier pass that (wrongly) gave tags colored pastel
  backgrounds like a typical SaaS dashboard.
- **Two typefaces, both deliberate**: `Jost` for all UI text (unchanged —
  keep this), and a monospace stack reserved for genuine numeric readouts
  (BPM values via `.tag`, cue timecodes, the countdown timer, via the
  `.mono-num` class) — real hardware displays these as monospace so
  digits align, so this is functional, not decorative.
  - **Font TODO**: the mono stack is `'Drafting Mono', 'IBM Plex Mono',
    ui-monospace, monospace`. Drafting Mono (Indestructible Type, OFL
    licensed, free for commercial use — github.com/indestructible-type/
    Drafting) is the intended font but isn't on Google Fonts or another
    public CDN, so right now the app actually renders IBM Plex Mono (the
    loaded fallback). Next step: download the actual webfont files from
    that repo's `fonts/` folder (or self-host from
    indestructibletype.com) and add a real `@font-face` pointing at
    self-hosted files, or a verified CDN mirror — don't guess a CDN URL
    for this one, confirm it actually resolves before shipping it.
- Tight radius (2px) and hairline borders throughout; tags go all the way
  to 0 radius as the sharpest element on screen. Depth comes from the
  paper/panel/ink value steps, not shadows — shadows stay minimal, used
  only on the floating transport/queue/pending/drawer panels that need to
  read as layered above the canvas.
