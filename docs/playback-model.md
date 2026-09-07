# Playback model — spec, audit, and what changed

Scope: the **currently shipped** player (`audioEngine.js`, `App.jsx`'s tick
loop, `PerformPage.jsx`/`LivePerformPage.jsx`, and the hop logic in
`core.js`). The future combinatorial rewrite (multi-input/output sockets,
weighted transitions, a from-scratch scheduler) is tracked separately in
`TODO.md` — this doc is about correctness of what's live today, not that
plan.

This spec was written **before** re-reading the implementation in detail,
then the implementation was checked against it line by line. That order
matters: a spec derived *from* the code just re-describes whatever the code
already does, bugs included, and a test written against that spec would
pass forever without ever catching the bug. See
`.claude/skills/correctness-check/SKILL.md` for the general method this
followed.

## 1. Concepts

- **Master deck** — a song's own uploaded audio, played via a
  `AudioBufferSourceNode`. At most one is "the main deck" at a time.
- **Produced fragment** — a separately-uploaded, separately-rendered audio
  clip: an **intro** (plays before a song's own master starts), an
  **outro** (plays as a song ends, instead of just letting the master run
  out), or a **transition** (plays between two specific songs, recorded to
  already contain the blend between them).
- **Cue point** — a fragment's `inSeconds`/`outSeconds`: the fragment
  splices out of the source song's master at `outSeconds` and back into the
  destination song's master at `inSeconds`. A fragment with no cue points
  is played to its natural end with no splicing math.
- **Hop** — the decided next step: `{ mode: 'cut' | 'transition', ending,
  starting, edgeId, id }` (or `id === END`). Computed once by
  `playlistNextHop`/an explicit queue commit, then *performed* identically
  by `performAdvance` regardless of what triggered it.
- **Session** — `nowPlayingId`, `queue`, `timeLeft`, `isPlaying`,
  `autoHistory`, etc. — the UI/React state. Kept authoritative for *what
  should be playing*; the audio engine is the thing that makes it *actually
  sound*.

## 2. The correct model, as pseudocode

```
# ---- starting a set ----
def startSet(songId, startMethod):
    # startMethod is 'intro' or 'cut' — never anything else; a direct
    # start never tries to replay "as if arrived via some specific
    # transition" (which transition would be ambiguous once a song can
    # have multiple inbound wires) — it is its own independent entry mode.
    stop_whatever_is_currently_sounding()
    if startMethod == 'intro' and an intro fragment exists for songId:
        play_fragment_to_end(introFragment)   # blocks until it naturally ends
    start_master(songId, offset=0)
    session.nowPlayingId = songId
    session.queue = []
    session.isPlaying = true
    session.timeLeft = duration(songId)

# ---- steady playback (once per tick) ----
def tick():
    if not session.isPlaying: return
    elapsed = real_elapsed_time_of_master_deck()   # sample-accurate when real audio exists
    hop = session.queue[0] or wiring.next_hop(session.nowPlayingId)
    triggerAt = hop.cue_point() if hop has a built cue point else duration(nowPlayingId)
    if elapsed >= triggerAt:
        performHop(hop, manual=false)
    else:
        session.timeLeft = duration(nowPlayingId) - elapsed

# ---- performing a hop (shared by the timer AND a manual action) ----
def performHop(hop, manual):
    # `manual` distinguishes WHY this hop is happening, which changes HOW
    # the audio is performed — not just is-it-happening:
    #   - the timer reaching a real cue point   -> honor the hop exactly:
    #     play the produced fragment, splice at its cue points, seamless.
    #   - a manual Skip                          -> ALWAYS a plain cut to
    #     the same destination, regardless of what's wired. Skip means
    #     "leave now", not "perform the fancy version, but immediately."
    #   - a manual Back                          -> not yet implemented
    #     (see open item below); would need its own explicit hop shape,
    #     not a reuse of performHop with reversed direction.
    destSongId = hop.id  (or END)
    if manual:
        hop = hop with mode/ending/starting forced to 'cut'

    if hop.id == END:
        if hop.ending == 'outro' and an outro fragment exists:
            play_fragment_to_end(outroFragment)
        stop_everything()
        session.setEnded = true
        return

    if hop.mode == 'transition':
        fragment = the specific wired transition clip
        # THE SEAMLESS PART: the main deck must stop and the fragment must
        # start at the exact same AudioContext time — not "stop now, then
        # asynchronously fetch/decode the fragment, then start it" (see
        # Finding 1 below). This requires the fragment's buffer to already
        # be decoded and ready *before* the cue point arrives.
        splice_out_of_main_deck_into(fragment, at=ctx_time_of(hop.cue_point()))
        play_fragment_to_end(fragment)   # blocks until it naturally ends
        start_master(destSongId, offset=fragment.inSeconds)
    else:  # cut, possibly with an outro/intro fragment attached
        if hop.ending == 'outro' and an outro fragment exists:
            play_fragment_to_end(outroFragment)
        if hop.starting == 'intro' and an intro fragment exists:
            play_fragment_to_end(introFragment)
        start_master(destSongId, offset=0)

    session.nowPlayingId = destSongId
    session.timeLeft = duration(destSongId)

# ---- pause / resume ----
def togglePlaying():
    session.isPlaying = !session.isPlaying
    if session.isPlaying: resume_audio_clock()   # freezes/resumes EVERYTHING
    else: suspend_audio_clock()                  # sounding right now — main deck or a fragment alike

# ---- seek ----
def seekPlayhead(fraction):
    offset = fraction * duration(nowPlayingId)
    if a fragment (not the main deck) is what's actually sounding right now:
        # there is nothing to seek — the fragment has its own fixed
        # timeline. Do NOT touch session.timeLeft either, or the displayed
        # countdown silently disagrees with what's actually audible.
        return
    if nowPlayingId has real uploaded audio:
        restart_main_deck_at(offset)
    session.timeLeft = duration(nowPlayingId) - offset

# ---- skip ----
def skipNow():
    performHop(next_hop(), manual=true)   # see performHop's `manual` branch above

# ---- back (NOT YET IMPLEMENTED — see open item below) ----
def goBack():
    raise NotImplemented

# ---- starting from an arbitrary node mid-graph ----
# Explicitly its own entry mode (see startSet above), not an attempt to
# reconstruct "as if you'd played from the true start" — that requirement
# is real but belongs to the v2 multi-input rewrite (TODO.md), where a
# destination's single arrival identity stops being well-defined once
# multiple predecessors can wire into it.
```

## 3. Audit findings

### Finding 1 — no lookahead: a transition's "seamless" handoff can have an audible gap (HIGH, not yet fixed)

`handleHandoff` (`audioEngine.js`) hard-stops whatever's currently sounding
(`_stopCurrentSound()`) **synchronously**, then `await`s
`loadBuffer(edge.audioUrl)` — a `fetch` + `decodeAudioData` round-trip —
before the transition clip's first sample plays. The first time a given
transition is ever played in a session, this is a real, audible dead-air
gap between "the original stopped" and "the transition started" — the
opposite of seamless. Once a buffer is cached (`bufferCache`), replays are
much faster, but the very first time through any given wiring is exactly
when a DJ is most likely to be testing it live.

**Status: partially fixed.** `audioEngine.js`'s new `prefetchHop` warms
`bufferCache` for the upcoming hop's fragment/destination once the tick
loop is within `PREFETCH_LOOKAHEAD_SEC` (6s) of the real cue point
(`App.jsx`'s tick effect) — `loadBuffer` already dedupes by URL, so calling
it repeatedly during that window is free. This removes the fetch+decode
latency from the critical path on a first play-through, which was the
worst-case version of the gap. It does **not** fix the underlying
reactive-timing slop — see Finding 2, which is the real remaining
architectural item.

### Finding 2 — ~1 second (or worse) scheduling slop (HIGH, architectural, not fixed)

The tick loop only checks `elapsed >= triggerAt` once per second
(`setInterval(..., 1000)` in `App.jsx`), and every handoff calls
`source.start(ctx.currentTime, ...)` — "start right now" — reactively,
never a precomputed future `AudioContext` time. A cue point built at
exactly `outSeconds = 47.20` can actually fire anywhere up to ~1 second
late, and browsers are free to throttle a backgrounded tab's timers well
past that. This is the direct cause of "not playing the right audio at the
right time" — the trigger itself is approximate before any network/decode
latency from Finding 1 even applies.

**Status: not fixed.** Fixing this properly means moving off `setInterval`
+ reactive `start(now)` entirely, toward pre-scheduling the next fragment's
`start()` call at an exact computed `AudioContext` time once the current
deck's remaining time drops under some lookahead window. That's a real
scheduler rewrite, not a contained bug fix — flagged in `TODO.md` rather
than silently attempted inside this pass.

### Finding 3 — Skip played the wired transition's audio instead of a plain cut (CONFIRMED BUG, FIXED)

`skipNow()` called the exact same `performAdvance` the automatic
cue-point timer uses, with no distinction — so a manual Skip mid-song
would still play out the wired transition's produced clip before actually
leaving, when the whole point of Skip is "leave now, plainly." The code's
own prior comment defended this ("the two call sites can never disagree
about what a hop actually does") — a reasonable-sounding invariant that
was simply the wrong invariant. This is the textbook version of "tests
would have passed": a test asserting *"skip and the timer produce the same
hop"* would have been green right up to today, while actively encoding the
bug.

**Fixed**: `performAdvance` now takes `{ forceCut }`; `skipNow` passes
`forceCut: true`, which still advances to the *same destination* the
wiring picked (so the Next list stays honest) but always performs it as a
plain cut — no fragment, no cue-point wait. `src/audioEngine.js`,
`src/playbackControls.js`.

### Finding 4 — no "Back" control exists at all (CONFIRMED GAP, NOT IMPLEMENTED — needs a design decision)

Neither `PerformPage.jsx` nor `LivePerformPage.jsx` expose any previous/
back action. `session.autoHistory` looks like it could serve this but
doesn't: it's populated **only** on pure-autoplay random picks (never on a
manual queue commit or a wired-transition hop, which is the normal case),
and it's read in exactly one place (`audioEngine.js`, to recover which
`mode` an autoplay pick used) — never for navigation.

Implementing this for real needs a genuine history log — every hop,
however it was reached, pushed onto a stack — and an actual product
decision this doc shouldn't make unilaterally: does Back **resume** the
previous song from wherever it had gotten to, or **restart** it from 0?
Does it replay that song's own original entry fragment (its intro, if it
had one) or cut in directly? Logged as an open TODO item with the question
named, not guessed at.

### Finding 5 — seeking during a fragment silently desynced the displayed time (CONFIRMED BUG, FIXED)

`seekPlayhead` always wrote `session.timeLeft` from the dragged fraction,
even when `engine.seekMain` returned `false` because a produced fragment
(not the main deck) was what was actually sounding. The scrub bar has no
gating on this — it's fully draggable throughout a transition/outro/intro
fragment's whole runtime — so dragging it mid-fragment made the displayed
countdown silently disagree with the real audio for the rest of that
fragment's duration (self-correcting only once the next master deck
starts and resets `timeLeft` fresh).

**Fixed**: `seekPlayhead` (`PerformPage.jsx`) now only writes `timeLeft`
when the seek actually landed on real main-deck audio, or when the song
has no uploaded master at all (the one case with no real deck to desync
from).

### Finding 6 — the transport controls existed as two independently hand-maintained copies (STRUCTURAL ROOT CAUSE, FIXED)

`togglePlaying`, `startSet`, `skipNow`, and `resumeSet` were each
implemented twice, nearly verbatim, in `PerformPage.jsx` and
`LivePerformPage.jsx` — despite `LivePerformPage.jsx`'s own header comment
already stating the intent that the two screens "can never disagree about
what a hop actually does." Two copies of the same logic is exactly the
mechanism by which they *can* disagree: fixing Finding 3 in one file and
forgetting the other would have silently reintroduced the bug on whichever
screen didn't get the fix. This is the concrete, named version of "I keep
having to re-surface the same class of issue."

**Fixed**: extracted into `src/playbackControls.js`'s `useTransportControls`
hook, used by both screens now — one implementation, one place to fix.

### Finding 7 — zero automated tests exist (STRUCTURAL, NOT FIXED HERE)

`test/` is an empty directory. Verification this whole project has relied
on ad hoc Playwright scripts written per round in `.scratch/` and deleted
immediately after — which only ever check the specific behavior just
implemented, never a persisted regression suite covering the scenarios
above. This is *why* "the tests pass" has been a meaningless signal: there
were no tests to disagree with a bug in the first place, and a same-session
manual check shares its author's blind spots with the code being checked
(see the skill this audit followed). Not fixed as part of this pass — the
user's own framing was report + fix + spec + methodology, not "write the
suite" — but it's the most consequential unaddressed item here, since
every fix above is only as durable as the next person's willingness to
re-derive this same audit from scratch.

## 4. What changed today

- `src/audioEngine.js` — `performAdvance` accepts `{ forceCut }` (Finding 3);
  new `prefetchHop`/`PREFETCH_LOOKAHEAD_SEC` (Finding 1).
- `src/App.jsx` — the tick loop calls `prefetchHop` once a hop's cue point
  is within the lookahead window (Finding 1).
- `src/playbackControls.js` — new; `useTransportControls`, the one shared
  implementation of Play/Pause, Skip, Start, Stop (Finding 6).
- `src/components/PerformPage.jsx` — uses the shared hook; `seekPlayhead`
  no longer desyncs `timeLeft` during a fragment (Finding 5).
- `src/components/LivePerformPage.jsx` — uses the shared hook.

## 5. Open items (not implemented — need a decision or a dedicated pass)

- **Back/previous control** (Finding 4) — **resolved by direct instruction,
  see §6.** No longer an open question.
- **Sample-accurate lookahead scheduling** (Findings 1 & 2) — **design
  finished, see §6**; not yet implemented.
- **A real regression suite** (Finding 7) — scenarios in §2 above are
  written to be testable as stated, independent of whichever
  implementation ends up satisfying them.

## 6. Round 2 — sample-accurate scheduling, and Back/Start resolved (design, not yet implemented)

### Back and Start, simplified by direct instruction

Both turned out not to need the open question in Finding 4 at all — the
answer is "restart", not "resume", and both are meant to behave like the
transport controls on any ordinary audio player, nothing v2-specific:

- **Start from anywhere** is unchanged from what's already shipped: Intro-
  or-cut from offset 0. No attempt to reconstruct "as if arrived via some
  specific transition" — that idea is dropped, not deferred.
- **Back**: if less than `BACK_RESTART_THRESHOLD_SEC` (proposed: 5s) into
  the current song, go to the **previous** song and restart it from 0; at
  or past that threshold, restart the **current** song from 0. Standard
  "previous track" behavior, nothing novel.
- **Both Skip and Back always land as a plain cut** — offset 0, no intro
  clip, no transition clip, regardless of what's wired. This is Finding
  3's `forceCut` behavior, and Back reuses it exactly rather than being a
  new code path.

This needs a real (if small) history stack — `session.history: songId[]`,
pushed with the previous `nowPlayingId` every time it changes for any
reason (a fired hop, a skip, a fresh start), *except* when the change is
itself caused by `goBack()`. No resume-state is stored per entry — a
songId is enough, since landing on it is always a restart.

```
BACK_RESTART_THRESHOLD_SEC = 5

def goBack():
    cancelScheduledPlan()
    if real_elapsed_time_of(nowPlayingId) < BACK_RESTART_THRESHOLD_SEC and history is not empty:
        destId = history.pop()
    else:
        destId = nowPlayingId
    performImmediateCut(destId)   # same forceCut path as Skip: offset 0, no fragment
```

### The actual fix for "playing the right audio at the right time"

Confirmed against current guidance (MDN's Web Audio best-practices page,
and the "A Tale of Two Clocks" scheduling pattern this whole problem
space traces back to — see Sources): the Web Audio API exposes its own
high-precision clock, `AudioContext.currentTime`, and every node's
`.start()`/`.stop()` takes an exact time on that clock. `setInterval` and
anything derived from it (this engine's whole tick loop) can fire late
under main-thread jank or background-tab throttling; the audio clock
can't drift the same way, because the audio hardware itself fires the
event at the sample-accurate time once it's scheduled. **The fix is to
stop deciding "should a hop happen" reactively at all, and instead
compute the exact future `AudioContext` time a hop must happen at, then
schedule it once — the moment its audio is loaded, however far ahead of
time that is.**

The canonical version of this (the metronome lookahead scheduler: a 25ms
tick scheduling anything landing within the next ~100ms) exists because a
metronome has an *open-ended stream* of future notes and doesn't want to
schedule thousands of them at once. That doesn't apply here — there is
only ever **one** pending hop at a time. So the simpler version fits
better: as soon as a hop's destination is known and its audio is decoded,
schedule the *entire* chain of `.start()`/`.stop()` calls for it
immediately, at their precisely computed times, no matter how far in the
future that is — Web Audio has no problem with that, and it removes the
need for any polling loop to drive the audio at all.

```
# One pending hop at a time — a "plan" is the fully-scheduled Web Audio
# call chain for it, cancellable up until its own trigger time arrives.

def scheduleHop(hopDecision):
    cueOffsetSec = hopDecision.cuePoint  # outSeconds, or full duration for a plain cut
    triggerCtxTime = currentMain.startCtxTime + (cueOffsetSec - currentMain.offsetSec)

    chain = fragments_for(hopDecision)   # e.g. [transitionClip], or [outroClip, introClip], or []
    prefetch_all(chain + [destination_buffer_if_any])   # start decoding now, regardless of how far off triggerCtxTime is

    await all buffers in chain ready   # bail out here (via a plan token, same pattern as today's _playToken) if superseded meanwhile

    currentMain.source.stop(triggerCtxTime)
    stepTime = triggerCtxTime
    for fragment in chain:
        fragmentNode = create_source(fragment.buffer)
        fragmentNode.start(stepTime)
        stepTime += fragment.buffer.duration
    if hopDecision.destSongId:
        destNode = create_source(destination_buffer)
        destNode.start(stepTime, hopDecision.destOffsetSec)   # 0 for a cut, edge.inSeconds for a transition

    return Plan(triggerCtxTime, destStartCtxTime=stepTime, destSongId=hopDecision.destSongId,
                pendingNodes=[...])   # for cancellation

def Plan.cancel():
    for node in pendingNodes not yet started (ctx.currentTime < node's own scheduled start):
        node.stop()   # calling stop() before a scheduled start cancels it outright, per spec
```

**When to (re)schedule or cancel** — this is the part that actually needs
care, since a plan computed against stale assumptions is worse than no
plan:

- **Main deck starts** → determine the hop decision immediately if it's
  already knowable (the graph's own wiring — the normal combinatorial
  case) and schedule it right away. If genuinely undecided yet (Live mode,
  no ending picked), there's nothing to schedule until it is.
- **The known hop decision changes** (a manual ending/transition gets
  picked in Live mode, the wiring is edited mid-set) → cancel the existing
  plan, schedule the new one.
- **Seek** → cancel the existing plan, recompute `currentMain.startCtxTime`/
  `offsetSec` from the new position, reschedule the *same* hop decision
  against the new timeline. If the seek lands past where `triggerCtxTime`
  already would have been, perform that hop immediately instead (same as
  if the tick had just detected it).
- **Skip / Back** → cancel the existing plan (its nodes haven't fired
  yet), then perform the plain-cut hop immediately at `ctx.currentTime` —
  these are deliberately instant, not scheduled.
- **Pause** → do **nothing** to the plan. `ctx.suspend()` freezes
  `currentTime` itself, which freezes every not-yet-fired scheduled event
  right along with whatever's currently sounding — this should compose
  for free, but needs to be verified empirically once implemented (per
  the correctness-check skill's own polish pass: confirmed, not assumed).
- **Stop / End Set** → cancel the plan, then stop as today.

A song with **no uploaded audio** has no buffer to schedule against —
this entire mechanism is moot for it, and it keeps using today's plain
wall-clock estimate. Seamlessness was never a meaningful concept for a
song with nothing real to be seamless *with*.

### Why this also answers "is it a UI problem or a logic problem"

Once scheduling is Web-Audio-native, the tick loop's job shrinks to
something purely cosmetic: notice, after the fact, that
`ctx.currentTime` has passed a plan's `destStartCtxTime`, and *only then*
update `session.nowPlayingId`/`timeLeft` to match what's already true in
the audio graph — never the other way around. The tick can be up to a
second late updating a label with zero audible consequence, because it
was never the thing deciding when sound happens. That gives a clean,
structural answer to "which kind of bug is this": if the audio itself
lands wrong (early, late, glitching, wrong clip), that's the scheduling
plan — a logic bug in `audioEngine.js`. If the audio is correct but a
label, highlight, or countdown briefly lags or shows a stale value,
that's the tick's cosmetic sync — a UI bug, incapable of being anything
else, because it no longer has any way to reach into what's actually
sounding.

### Status

Design only — validated against current Web Audio guidance, not yet
implemented. Next step is rewriting `audioEngine.js` around this Plan
model and cutting the tick loop over to the cosmetic-only role described
above.

Sources: [MDN — Web Audio API best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices) · [web.dev — A tale of two clocks](https://web.dev/articles/audio-scheduling) · [MDN — AudioBufferSourceNode.start()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)

## 7. Round 3 — every timing-driven visual, in depth (design, not yet implemented)

Scope for this round: not just the scheduling model, but **every UI
element that claims to show playback position** — progress bars, the
scrub bar, the per-socket countdown ring, elapsed/remaining text. This is
explicitly for a live-performance context, so "looks basically right" is
not the bar; sample-accurate audio scheduling (§6) is necessary but not
sufficient if the *display* built on top of it is still coarse.

### Inventory — every place playback position is shown

| Element | File | Driven by |
|---|---|---|
| Bottom player bar scrub (`Playhead`) | `SequencePane.jsx` | `session.timeLeft` (prop `pct`) |
| Live-screen progress bars (`LiveCard`/`ProgressBar`) | `LivePerformPage.jsx` | `session.timeLeft` (via `elapsed`) |
| Per-socket countdown ring (`CountdownRing`) | `GraphNodes.jsx` | `position.elapsed` (context, from `session`) |
| Elapsed/duration text (`node-position`) | `GraphNodes.jsx` | same `position` context |
| Live spectrum bars (`LiveWaveform`) | `GraphNodes.jsx` | **`requestAnimationFrame` reading `engine.getLevels()` directly — not session state** |

That last row is the important one: **one component already does this
correctly**, and it's not an accident — its own comment explains exactly
why (a real reading off the analyser, updated every frame via direct
`style.height` writes through refs, deliberately bypassing React state
for a value that changes 60 times a second). The fix for the other four
rows is to bring them in line with a pattern the codebase already trusts,
not invent a new one.

### Root cause of "jumpy, unreliable, sometimes stalls"

All four of the other rows ultimately trace back to `session.timeLeft`,
which only changes once per second — inside `App.jsx`'s `setInterval`
tick. That's three separate, compounding problems, not one:

**1. "Jumpy" — the update rate itself.** A value that visually moves only
once a second reads as stepping, not gliding, especially on a wide scrub
bar where one second is several pixels. Two of the four rows
(`Playhead`, `live-progress-fill`) already have a partial CSS-transition
band-aid (`.3s ease-out` and `.2s linear` respectively) — meaning the bar
glides for 200–300ms, then sits **motionless for the remaining 700–800ms
of every second** before the next glide starts. That's not smooth, it's a
glide-then-pause cycle, which can look worse than a clean instant step
once you notice the rhythm. `CountdownRing` has no transition at all —
its dash-offset snaps immediately, every second, with no smoothing
whatsoever.

**2. "Unreliable" — the elapsed-time *source* silently switches clocks.**
`App.jsx`'s tick computes elapsed one of two ways: `engine.getMainElapsed()`
(real, sample-accurate, `AudioContext`-derived) when the main deck is
confirmed to be `nowPlayingId`'s own audio — or a wall-clock accumulation
(`(duration - prev.timeLeft) + dtSec`) for everything else, including the
instant right after every hop. These two clocks do not agree with each
other, and the switch between them is invisible until it produces a
visible correction: right after a hop, `timeLeft` resets to the new
song's full duration and the wall-clock branch starts counting *up from
that hop's session-state-write moment* — not from whenever the real audio
actually starts. The moment `getMainElapsed` later comes back with a real
number (once the destination's own master genuinely begins), the display
snaps to reconcile the two clocks' disagreement — typically backward,
since the real audio always starts later than the wall-clock guess
assumed. A progress bar that visibly jumps backward is exactly what
"unreliable" describes.

**3. "Stalls along with the audio" — the wall-clock branch runs *through*
fragment playback and load latency, fictitiously.** This is the biggest
one, and it's not brief. The instant a hop is decided, `advanceSession`
sets `timeLeft` to the destination song's full duration — but if that hop
has a transition/outro/intro fragment attached, the fragment can take
several real seconds to play, and the destination's own master doesn't
start until it's done (plus whatever load latency Finding 1 already
covers). For that entire window, the UI is counting up against the
*destination song's own duration* as if its master had already started —
when what's actually sounding is a completely different audio asset (or
nothing at all, mid-load). This isn't a timing approximation, it's
showing a number that has no relationship to what's audible. Once the
real master finally starts (at `edge.inSeconds`, not 0), the reconciling
jump from problem 2 lands on top of this.

**Confirmed via research, not assumed:** Chrome exempts a tab from
`setInterval`/`requestAnimationFrame` throttling *only while it's audibly
producing sound* — a genuinely silent stretch (exactly the load-latency
gap and the "hasn't started the real master yet" window above) does not
carry that exemption, so if the tab isn't focused at that moment, the
1Hz tick itself can be clamped to 2s+ increments right when accuracy
already matters most. This compounds problem 3 in exactly the scenario
that matters for live use — a DJ glancing at another window mid-set.

### The fix — two decoupled layers, neither of which needs Tauri

**Layer A (engine): one authoritative position query, sourced from the
Plan model in §6, never from a wall-clock accumulation once real audio
exists.**

```
def getPlaybackPosition():
    if a Plan's fragment chain is currently between triggerCtxTime and destStartCtxTime:
        # figure out which step of the chain we're in from ctx.currentTime directly
        return { phase: 'fragment', kind, elapsedSec: ctx.currentTime - stepStartTime, durationSec: stepBuffer.duration }
    if the main deck is confirmed sounding:
        return { phase: 'main', songId, elapsedSec: ctx.currentTime - mainStartCtxTime + offsetSec, durationSec }
    return { phase: 'silence' }   # e.g. still awaiting a buffer load — shown as such, not guessed at
```

No `Date.now()`/`dtSec` accumulation anywhere in this path. For a song
with **no uploaded audio** (nothing to schedule against), the fallback
still shouldn't accumulate off wall-clock `Date.now()` deltas — record the
`ctx.currentTime` the countdown conceptually started at (the
`AudioContext` clock is monotonic and jank-immune even when nothing is
actually playing through it, since it exists the moment `ensureContext()`
has ever run) and compute elapsed as a subtraction each read, the same
shape as the real case. This won't be sample-accurate — there's nothing
real to be accurate *to* — but it stops being vulnerable to timer drift
independently of that.

**Layer B (UI): a single `requestAnimationFrame` loop per consumer,
matching `LiveWaveform`'s own already-correct pattern — direct ref writes,
no React re-render for the continuous value.**

```
function usePlaybackFrame(onFrame):
    useEffect(() => {
        let raf
        function tick() { onFrame(engine.getPlaybackPosition()); raf = requestAnimationFrame(tick); }
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [])
```

`Playhead`, `LiveCard`'s `ProgressBar`, and `CountdownRing` each use this
to write their own width/dash-offset/text directly via a ref every frame,
the same way `LiveWaveform` already writes bar heights. `session.timeLeft`
stays in React state for what it's actually good for — discrete
transitions (a new song started, the set ended) — but stops being the
thing continuous visuals are computed from. The CSS-transition band-aids
on `Playhead`/`live-progress-fill` become unnecessary once the value
itself updates every frame — remove them rather than leave dead
smoothing code fighting a value that's already smooth.

**Why this survives being backgrounded, not just looks smoother while
focused:** `requestAnimationFrame` pausing in a backgrounded tab is
*correct* here — nobody's watching the bar, so it doesn't need to render.
What matters is that it doesn't need to "catch up" when the tab comes
back, because Layer A always computes position fresh from
`ctx.currentTime` rather than accumulating incrementally — the very next
frame after refocus shows the true position immediately, no backward
jump, no stall. And per §6, the actual *audio* was never depending on
either timer in the first place once Plan-based scheduling lands — this
round is purely about the display finally being honest about what that
schedule already guarantees.

### Confirmed fine, not touched (per the correctness-check polish pass)

- **`AudioContext`'s default latency is already optimal.** `'interactive'`
  is the default `latencyHint` when none is specified — the engine already
  gets the lowest-latency mode without any code change.
- **`LiveWaveform`'s rAF/ref-write pattern is the right template**, not
  something to redesign — Layer B above is that same pattern applied
  three more places, not a new approach.

### Not part of this design (noted, not solved here)

Output-device routing (`AudioContext.setSinkId`, choosing a specific
audio interface) would matter for a real live rig but is a separate
feature request, not a correctness fix — not addressed here.

### Status

Design only. A future Tauri/desktop build doesn't change any of this —
Web Audio's own scheduling and clock are already immune to the browser
timer-throttling concerns this section addresses, so nothing here is a
web-specific workaround being designed around.
