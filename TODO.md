# Eskimo Studio — handoff notes

This file is the backlog and the reasoning behind it, for whoever (human or
agent) picks this up next in Claude Code. `index.html` is a complete,
working single-file build (React 18 + Babel Standalone via CDN, no build
step) — open it in a browser and it runs. `supabase/schema.sql` and
`worker/upload-worker.js` are real, deployable backend pieces that are
already wired into the app — they just need your account-level setup and
keys (see **Your tasks**, below) before they turn on.

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

## Terminology glossary — stick to this everywhere (code, UI copy, docs)

Kept small on purpose so a producer friend can figure the app out without
a manual. Standard DJ words are kept as-is; only the app's own states got
simplified, to exactly three:

- **Playing** — the song live right now.
- **Next** — the one song staged/armed to follow it (the first list in the
  Sequence pane).
- **Later** — what's reachable *after* whatever's staged in Next (the
  second list) — a two-move lookahead, not an open chain.
- **Cut** — a hard edge with no fragment (replaces the old "cold cut" /
  "play out naturally" wording).
- Kept as-is: Transition, Intro, Outro, BPM, Key, Cue.

## Graph model — decided, don't revisit

Single node per song, directed edges between them (transitions / intros /
outros). A remix is just another song with its own node — there is no
"versions" sub-concept on a song anymore (see **Done this pass** below for
why that changed). This was considered and rejected: a "one-way flow"
graph where nodes repeat per path so nothing ever crosses itself. It
doesn't work as the primary model because a loop unrolled that way is
infinite — there's no node count to cap it at that isn't arbitrary — and
any song with more than one incoming and outgoing edge would need a
separate node per path through it, which blows up combinatorially in
exactly the graphs this product wants to encourage (big, interconnected
ones).

What *should* change is the **layout**, not the data model — still not
built:
- Forward-flowing transitions (the common case) render as short, straight
  arrows.
- Any edge that loops back to something earlier in the current flow
  direction renders as a curved arc routed around the outside, visually
  distinct from a forward edge — instead of a straight line crossing
  through other nodes.
- An optional "tidy layout" auto-arrange (left-to-right or top-to-bottom
  by rough energy / BFS distance from the person's most-used opener),
  toggle-able, that never overrides manual dragging unless the person
  asks for it.

## Done this pass

- **Type + layout overhaul.** Wordmark is now the real Gnomon\* Foreground
  face (indestructible type\*, OFL) — compiled straight from the
  foundry's UFO source with `fontmake` since the repo only ships a
  compiled build of the *variable shadow layer*, not the bold display
  font; self-hosted as a base64 `@font-face` so the file stays single-file
  and build-step-free. Body copy stays Jost (it already is indestructible
  type's own font) but at a heavier default weight and darker secondary
  grays — the old thin/washed-out look was a weight/contrast issue, not a
  wrong-font one. The floating inspect drawer that used to overlap flat
  form pages (Upload Song, Add Audio) is gone entirely — see below for
  where its jobs moved.
- **Versions dropped.** A remix is now a first-class song with its own
  id/BPM/key, connected like anything else via Add Audio. Simpler data
  model, one fewer concept to explain to a producer friend.
- **Perform page split into two panes.** Graph pane (visual planning —
  hover a reachable node for a quick-action card: stage it as Next,
  confirm, pick Transition vs Cut) and a persistent Sequence pane (Playing
  block with an always-visible **End Set**; Next list; Later list; a
  compact committed-path breadcrumb). Hard-start, hard-stop, and
  transition-type choices all live in one obvious, always-visible place
  instead of behind a node click.
- **Graph readability.** All edges solid (a single line can't honestly
  label one specific transition when several can exist between the same
  two songs, so per-edge stat tags are gone). In/out counts on every node
  are bare numbers in a fixed spot (`↓2 ↑3`, no words) — one thing to
  learn once instead of relearning per element.
- **Library simplified** to a flat, searchable, accordion list — click a
  row for its built pieces and inline editing, no separate panel.
- **Countdown mechanic** (Next-list rows drain a shared timer while
  Playing, tied to a mocked `durationSec` per song — see the code comment
  by `mockDuration` in `index.html` for exactly what's simulated vs real
  here; real duration should come from actual audio metadata once real
  detection lands, below).
- **Backend scaffolding is real, not just planned**: `supabase/schema.sql`
  (one RLS-scoped table, anonymous-auth-keyed) and
  `worker/upload-worker.js` (a Cloudflare Worker that writes straight to
  an R2 bucket binding and hands back a public URL — no AWS-style signing,
  no R2 credentials ever touch the browser) are both wired into
  `index.html` already, gated behind the empty `APP_CONFIG` values at the
  top of the file. Fill those in and both turn on with no further code
  changes.

## Your tasks (only you can do these — accounts, keys, hosting)

1. **Enable GitHub Pages.** Repo Settings → Pages → Source: "GitHub
   Actions". `.github/workflows/pages.yml` is already in the repo — the
   next push to `main` gets you a live URL with no other setup. It works
   with zero backend configured (local-storage only, exactly like now).
2. **Supabase project** (for cross-device sync):
   - Create a project at supabase.com.
   - Project Settings → API → copy the **Project URL** and the **anon
     public** key (never the `service_role` key — it must never leave
     Supabase).
   - Authentication → Providers → enable **Anonymous Sign-Ins** (there's
     no login screen yet, so this is what gives each browser a stable
     identity to sync under).
   - SQL Editor → run `supabase/schema.sql`.
   - Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` as **repository secrets**
     (Settings → Secrets and variables → Actions) so the Pages workflow
     bakes them into the deployed copy — or paste them directly into
     `APP_CONFIG` in `index.html` for local testing.
3. **Cloudflare R2 bucket** (for audio file storage):
   - Create a bucket (dashboard, or `npx wrangler r2 bucket create
     eskimo-studio-audio` — name matches `worker/wrangler.toml`).
   - Turn on public access for it (bucket → Settings → Public access —
     the free `r2.dev` subdomain is fine to start) and put that URL into
     `worker/wrangler.toml`'s `PUBLIC_BUCKET_URL`.
   - Deploy the worker: `cd worker && npx wrangler login && npx wrangler
     deploy`. Copy the resulting `*.workers.dev` URL.
   - Add `UPLOAD_WORKER_URL` as a repository secret (or paste into
     `APP_CONFIG` locally), same as above.
4. **Tell me when the above is done** (or hand me the values) — wiring
   anything further (auth UI beyond anonymous sign-in, tightening the
   worker's CORS from `*` to your real Pages origin, etc.) is on me once
   real keys exist to test against.

## My tasks (engineering backlog)

- [ ] Once you've done the Supabase/R2 setup above: verify the sync and
      upload paths end-to-end against your real project (they're wired
      and code-complete but only testable against live credentials).
- [ ] Tighten `worker/upload-worker.js`'s CORS (`ALLOWED_ORIGIN`) to your
      actual Pages origin once you have one, instead of `*`.
- [ ] **Real audio detection.** Replace `pickDetectedSongs` (the
      deterministic mock in `core.js`) with real analysis: **Essentia.js**
      (WebAssembly build of the Essentia C++ MIR library) runs entirely
      client-side and can detect BPM, musical key, Camelot code, *and
      actual track duration* directly from the dropped file — this
      should also replace `mockDuration`, making the Sequence pane's
      countdown mechanic real instead of simulated.
- [ ] **Autoplay / infinite set mode.** The reachability the graph already
      computes (`computeReachability` + `oneHopReachable` in `core.js`) is
      exactly the input an auto-picker needs — Next is already "what's
      valid to go to," Later is already a second hop ahead. Add: a policy
      for picking (random among built/verified edges; weighted to avoid
      repeating a song too soon), and closed-loop detection (whether the
      current position sits in a strongly-connected component of verified
      edges, i.e. can wander forever without dead-ending) surfaced on the
      graph so the person can see which parts of their graph are
      autoplay-safe.
- [ ] **"Flow" visual pass on the graph canvas** — particles/light pulses
      traveling along built edges, for an idle ambient view during a set
      and as a shareable "signature" export of a graph.
- [ ] **Loop-back arc layout** from the Graph model section above — still
      not built; forward edges are straight, nothing routes loops as
      arcs yet.
- [ ] **Node CRUD polish**: bulk operations in Library (multi-select
      delete/tag), duplicate-song detection on Upload Song.
- [ ] **UI/UX research pass**, since this is going out to producer
      friends to test cold:
      - Accessibility: contrast ratios on the new type scale, visible
        focus states, keyboard navigation for the graph and Sequence
        pane (currently mouse-only).
      - Usability testing with the actual producer friends — watch where
        someone unfamiliar with the app gets stuck, particularly around
        the Next/Later staging flow and the hover-card vs. Sequence-pane
        dual entry points.
      - Icon audit: a couple of hover-card/sequence toggles are
        text-label chips (Transition/Cut/Intro) rather than icons — see
        if a producer group actually prefers icons here or if the words
        are clearer; don't guess, ask them.
- [ ] **Performance research + work**, biggest levers first:
      1. **Stop shipping Babel Standalone.** Right now the JSX is
         transpiled *in the browser, on every load* — this is the single
         biggest cost in first paint. Moving to a prebuilt bundle
         (esbuild or Vite) while keeping the existing
         core.js/app.jsx/styles.css split (the file already documents
         itself as splittable this way) would cut it dramatically. This
         is the highest-value performance change available and should
         happen before the app gets much bigger.
      2. Isolate the 1-second countdown tick into its own leaf component
         (it currently lives in `App`'s top-level state, so every tick
         re-renders the whole tree including the graph canvas).
      3. Memoize `computeReachability`/`oneHopReachable` harder if the
         graph grows large — currently recomputed on most renders via
         `useMemo` but the dependency array is coarse (whole `songs`
         object).
      4. Virtualize the Library list once someone's crate gets into the
         hundreds of songs (it's a flat unvirtualized DOM list right
         now).
      5. Profile the SVG edge rendering at a large graph size (100+
         songs, 300+ edges) — plain `<line>` elements should hold up
         fine, but confirm before assuming it.

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
  original "eski" look and it's staying. Contrast was raised this pass
  (darker `--muted`/`--faint`, heavier default text weight) specifically
  because the first version read as thin/weak — this wasn't a font
  change, Jost was already correct.
- **One accent color**: a dusty pastel purple (`--accent: #8b7bb8`),
  spent only on interactive/active state — active nav item, primary
  "confirm" actions, the Next/Later highlight on the graph, focus rings,
  progress fill. Never on static data.
- **Data tags (BPM, key, dead-end) are brutalist, not SaaS pills**:
  plain bordered boxes (`border-radius: 0`), monospace type, no fill, no
  per-category color — every tag is just ink-on-transparent with a
  hairline border. The label text carries the meaning ("128 BPM", "A
  min", "dead end"); color doesn't need to repeat it. Edges on the graph
  canvas dropped their per-edge stat tags entirely this pass (see **Done
  this pass**) — the tag style itself is unchanged, it's just no longer
  used on hover-tooltips over lines.
- **Wordmark**: Gnomon\* Foreground (indestructible type\*, OFL-1.1),
  self-hosted as a base64 `@font-face`, used *only* for the sidebar
  wordmark — it's an 88-glyph WWII-poster display face, never body text.
  Compiled from `github.com/indestructible-type/Gnomon`'s UFO source with
  `fontmake` (pure Python, no FontForge binary needed) since the repo
  only ships a prebuilt copy of the variable *shadow* layer, not the bold
  display letterforms.
- **Two typefaces, both deliberate**: `Jost` for all UI text (indestructible
  type's own font, unchanged font choice — the weight/size got heavier
  this pass, not the font), and a monospace stack reserved for genuine
  numeric readouts (BPM values via `.tag`, cue timecodes, the countdown
  timer, via the `.mono-num` class) — real hardware displays these as
  monospace so digits align, so this is functional, not decorative.
  - **Font TODO**: the mono stack is `'Drafting Mono', 'IBM Plex Mono',
    ui-monospace, monospace`. Drafting Mono (Indestructible Type, OFL
    licensed — github.com/indestructible-type/Drafting) is the intended
    font but isn't on Google Fonts or another public CDN, so it currently
    renders as IBM Plex Mono (the loaded fallback). Same fix pattern as
    Gnomon above would work here (clone, compile with fontmake, self-host
    as base64) if this becomes worth doing — Drafting Mono's repo should
    be checked for whether it ships a prebuilt binary before repeating
    the from-source compile step.
- Tight radius (2px) and hairline borders throughout; tags go all the way
  to 0 radius as the sharpest element on screen. Depth comes from the
  paper/panel/ink value steps, not shadows — shadows stay minimal, used
  only on the floating Sequence-pane-adjacent hover card that needs to
  read as layered above the canvas.
