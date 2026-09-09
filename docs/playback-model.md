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

### Finding 2 — ~1 second (or worse) scheduling slop (HIGH, architectural, FIXED)

The tick loop only checks `elapsed >= triggerAt` once per second
(`setInterval(..., 1000)` in `App.jsx`), and every handoff calls
`source.start(ctx.currentTime, ...)` — "start right now" — reactively,
never a precomputed future `AudioContext` time. A cue point built at
exactly `outSeconds = 47.20` can actually fire anywhere up to ~1 second
late, and browsers are free to throttle a backgrounded tab's timers well
past that. This is the direct cause of "not playing the right audio at the
right time" — the trigger itself is approximate before any network/decode
latency from Finding 1 even applies.

**Status: fixed — see §6.** `audioEngine.js`'s `scheduleHop`/`_plan` model
replaced the reactive `setInterval` + `start(now)` path entirely: the
instant a hop's destination is known and its buffers are decoded, the
whole chain of `.start()`/`.stop()` calls is scheduled against exact
future `AudioContext` times, not decided reactively once a second. The
tick loop's only remaining job is noticing, after the fact, that a
scheduled plan has fired and syncing `session` state to match — see §6's
"why this also answers is it a UI problem or a logic problem".

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

### Finding 4 — no "Back" control exists at all (CONFIRMED GAP, FIXED — see §6)

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

## 5. Open items

- **Back/previous control** (Finding 4) — **implemented, see §6.**
- **Sample-accurate lookahead scheduling** (Findings 1 & 2) — **implemented,
  see §6** (the Plan model in `audioEngine.js`) **and §7** (the rAF
  presentation layer built on top of it).
- **A real regression suite** (Finding 7) — still not built. Verification
  has continued to be ad hoc Playwright scripts written per round and
  discarded, same caveat as before — the scenarios in §2 remain testable
  as stated, independent of whichever suite eventually covers them.

## 6. Round 2 — sample-accurate scheduling, and Back/Start resolved (implemented)

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

**Implemented.** `audioEngine.js` carries the Plan model exactly as
designed above (`_plan`, `scheduleHop`, `cancelPlan`, `consumePlan`,
`_createSource`); `App.jsx`'s tick loop was cut over to the cosmetic-only
role — it schedules/reschedules a plan when the known hop changes, and
otherwise only notices a fired plan and syncs `session` state
(`syncSessionFromFiredPlan`) or updates the displayed countdown, never
deciding "should a hop happen" itself for a real deck. Back/Start ship as
`playbackControls.js`'s `goBack`/`jumpToSong`/`startSet`, matching the
pseudocode above exactly (`BACK_RESTART_THRESHOLD_SEC = 5`,
`session.history`, always a plain cut via the same `forceCut` path as
Skip). Verified directly against real Web Audio behavior via Playwright
(monkey-patched `AudioBufferSourceNode.start`/`stop` call recording, and
real playback timing checks), not just code review.

Sources: [MDN — Web Audio API best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices) · [web.dev — A tale of two clocks](https://web.dev/articles/audio-scheduling) · [MDN — AudioBufferSourceNode.start()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)

## 7. Round 3 — every timing-driven visual, in depth (implemented)

Scope for this round: not just the scheduling model, but **every UI
element that claims to show playback position** — progress bars, the
scrub bar, the per-socket countdown ring, elapsed/remaining text. This is
explicitly for a live-performance context, so "looks basically right" is
not the bar; sample-accurate audio scheduling (§6) is necessary but not
sufficient if the *display* built on top of it is still coarse.

### Inventory — every place playback position is shown

| Element | File | Driven by (at the time of this audit) |
|---|---|---|
| Bottom player bar scrub (`Playhead`) | `SequencePane.jsx` | `session.timeLeft` (prop `pct`) |
| Per-socket countdown ring (`CountdownRing`) | `GraphNodes.jsx` | `position.elapsed` (context, from `session`) |
| Elapsed/duration text (`node-position`) | `GraphNodes.jsx` | same `position` context |
| Live spectrum bars (`LiveWaveform`) | `GraphNodes.jsx` | **`requestAnimationFrame` reading `engine.getLevels()` directly — not session state** |

(The Live screen's own progress bars, `LivePerformPage.jsx`'s
`LiveCard`/`ProgressBar`, were in this inventory at the time of the
audit — the whole screen was dropped by direct instruction before this
round shipped, so there's nothing left to fix there; see Status below.)

That last row is the important one: **one component already does this
correctly**, and it's not an accident — its own comment explains exactly
why (a real reading off the analyser, updated every frame via direct
`style.height` writes through refs, deliberately bypassing React state
for a value that changes 60 times a second). The fix for the other rows
is to bring them in line with a pattern the codebase already trusts, not
invent a new one.

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

**Superseded by §10**, once real fragments actually reached a live
display: switching to a separate `'fragment'` phase with its own
from-zero clock is exactly what a caller must NOT do across that
boundary if it wants one continuous, non-jumping number — the shape above
is kept here only as the original reasoning trail, not the current
contract. Read §10 for what `getPlaybackPosition` actually returns now.

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

**Found during this round's end-to-end verification, fixed in the next
round:** `session.isPlaying`/`nowPlayingId` are persisted (`Store.save`),
but nothing re-established the engine's own ctx anchor from that
persisted state on load — a browser refresh mid-set left `session`
claiming a song was playing while `engine._current` was genuinely `null`.
In that state, seeking landed on the tick's wall-clock fallback, and a
periodic tick that captured its own `prev` snapshot before the seek's
`setSession` committed could overwrite it with a value computed from that
stale snapshot.

**Fixed:** `App.jsx` now forces `isPlaying: false` on every load,
regardless of what was persisted — a reload tears down the AudioContext
entirely, so nothing is genuinely audible right after one, and the
session shouldn't claim otherwise. With `isPlaying` false the tick's own
loop never runs at all until a real Play press, which is what removes the
race outright (not just narrows it) rather than reconstructing engine
state speculatively on every load. A one-shot mount effect
(`engine.restoreCosmeticPosition`) still restores the correct resting
position for the scrub bar/countdown rings immediately — the same
lightweight ctx-anchored `'silent'` kind already used for a song with no
uploaded master, so it costs nothing beyond one plain object when
`nowPlayingId` is set, and nothing at all when it isn't. `togglePlaying`
(`playbackControls.js`) now checks whether the anchor sitting there is
the right *kind* for what's actually wired (real audio needs `'main'`,
not the cosmetic `'silent'` one) and reconstructs it for real, at the
persisted offset, inside the click itself — satisfying the browser's
autoplay-gesture requirement rather than a plain `engine.resume()`
silently doing nothing. `startMain` gained an optional `offsetSec` param
(default 0) so resuming mid-song reuses the exact same path a fresh start
already takes.

### Status

**Implemented.** `engine.getPlaybackPosition()` (Layer A) and
`usePlaybackFrame` (Layer B, `playbackControls.js`) ship as designed
above. `Playhead` (`SequencePane.jsx`) and `CountdownRing`
(`GraphNodes.jsx`) both read it every animation frame and write straight
to their own DOM/SVG attributes through refs — the CSS-transition
band-aids on `Playhead` were removed, since the value itself is now
genuinely continuous rather than stepping once a second. The Live
screen's own progress bars are moot (screen dropped, see the inventory
note above). `node-position`'s elapsed/duration text was deliberately
left on the once-a-second context value — a text counter ticking at 1Hz
reads as a normal player, unlike a bar or ring visibly stepping, so
there was nothing to fix there **— this held for ordinary once-a-second
stepping, but not for the case §10 found: that same value doesn't just
step coarsely once a fragment starts, it freezes outright, for the
fragment's entire real duration. See §10 for the fix (which also
generalized the position model itself well beyond just this text).**
Verified via Playwright against the real
engine: a 20-frame sample of a scrub bar's fill width, and separately of
a countdown ring's stroke-dasharray, both show smooth per-frame movement
with no 1Hz stepping.

A future Tauri/desktop build doesn't change any of this — Web Audio's
own scheduling and clock are already immune to the browser
timer-throttling concerns this section addresses, so nothing here is a
web-specific workaround being designed around.

## 8. Round 4 — an outro has no out point, an intro has no in point (implemented)

Direct correction from the DJ, superseding part of §1/§2 above: an
**Outro** has no real early cue point on the main deck at all, and an
**Intro** has no real cue point on the destination at all. Concretely:

- **Outro**: the main deck always plays to its own full natural duration —
  never cuts early at some `outSeconds`, however that value was detected
  or entered. The outro clip is what carries a transition-like feel, but
  the *song being left* is never truncated for it.
- **Intro**: the destination song always starts at offset 0 — never at
  some detected `inSeconds`. The intro clip is what leads into the song;
  the song itself always starts fresh.

§1/§2's "a fragment splices out at `outSeconds` and back in at `inSeconds`"
is only true for a **Transition** (a real two-sided splice with a
deliberately-shortened main deck on both sides — that mechanic is
unchanged). `outSeconds`/`inSeconds` on an Outro/Intro edge are still
stored and still meaningful — occlusion-clash detection
(`core.js`'s `occludedTransitions`) uses them to warn when two produced
pieces off the same song would clash — but they are informational
timecodes on the *reference song's own master*, not a live playback
trigger, for Outro/Intro.

### Why the old "cut early" behavior existed, and the real fix

An earlier fix (§3, this doc's own Finding-shaped comment in
`transitionTriggerElapsed`) had the main deck cut early at an outro's
`outSeconds`, matching Transition's own mechanic — reasoning that the
outro clip is commonly uploaded still carrying the original song's own
tail (so detection can correlate it), and playing the clip from its own
t=0 right after the *full* song would replay that overlap a second time.
That reasoning about the overlap was correct; cutting the *main song*
short to avoid it was not the right fix, and directly caused two of this
round's reported symptoms: it's why a real outro upload measured with a
3:18 duration only ever played "the regular version instead" up to the
early cutoff, and a large part of why re-seeking near the end could
double up material (the main deck's own natural tail and the outro
clip's copy of it, both ending up scheduled).

**The actual fix**: never move the main deck's own cue point. Instead,
trim the *clip's own internal timeline*:

- `audioDetect.js`'s `detectMatch` now also returns `leftClipStartSec` /
  `rightClipEndSec` — solving the same correlation lag for the **dropped
  file's own timeline** instead of the reference song's. `leftClipStartSec`
  is where, inside the outro clip itself, the original song's own overlap
  ends and genuinely new material begins. `rightClipEndSec` is where,
  inside the intro clip itself, the destination's own overlap begins (the
  clip should stop before there).
- `AddAudio.jsx` saves these as `edge.clipStartSec` (Outro) /
  `edge.clipEndSec` (Intro) — undefined when there was no confident
  detection to derive them from, which falls back to the pre-existing
  "play the whole clip" behavior.
- `audioEngine.js`: `_playClipToEnd(buffer, offsetSec, clipEndSec)` now
  takes the third `AudioBufferSourceNode.start(when, offset, duration)`
  argument — an outro clip starts at `offsetSec = edge.clipStartSec || 0`
  (skips its own duplicated tail); an intro clip stops at
  `clipEndSec = edge.clipEndSec` (never plays its own trailing overlap).
  `buildHopDecision`'s outro branches (both an End-Set outro and a
  cut-ending-in-outro hop) now always use `currentBufferDurationSec` as
  the cue point, never `edge.outSeconds`; its fragment descriptors carry
  the same `offsetSec`/`clipEndSec` through to `scheduleHop`'s
  per-fragment `.start()` calls. `core.js`'s `transitionTriggerElapsed`
  (the reactive fallback path, for a song with no real audio to schedule
  the Plan against) now only special-cases `mode === 'transition'`;
  an outro-ending hop always falls through to the full song duration.

Verified via the instrumented-`AudioBufferSourceNode.start()` technique
against real synthetic WAVs: an 8s main song plus an outro clip with
`clipStartSec=3` schedules the clip's own `start(8, 3)` — the main deck's
own `stop()` also lands at 8, never earlier — and symmetrically an intro
clip with `clipEndSec=5` schedules `start(0, 0, 5)` with the destination
starting immediately after at offset 0, not at the clip's own natural end.

### Confirmed bug found and fixed alongside this: premature `consumePlan`

While verifying the above, the live scrub bar's colored-zone/light-up
behavior (the `Playhead` redesign in `SequencePane.jsx`) never actually
lit up for an **End-Set outro** hop specifically,
despite the audio itself scheduling and playing correctly underneath.
Root cause, in `App.jsx`'s tick: it treated a Plan as "already fired" via
`engine.ctx.currentTime >= plan.destStartCtxTime` — but an End-Set outro
has no destination, so `destStartCtxTime` is `null`, and `now >= null`
coerces to `now >= 0` in JS, which is true from the very first tick after
scheduling. That called `engine.consumePlan` and wiped `_plan` long
before the outro fragment actually started, which is exactly why
`getPlaybackPosition` could never report `phase: 'fragment'` for this
case — there was no plan left to check against by the time the crossing
actually happened. It also meant `syncSessionFromFiredPlan` set
`session.setEnded = true` immediately upon scheduling, not once the
outro clip actually finished — confirmed separately: `session.setEnded`
now only flips true once the real elapsed time covers the full main song
plus the full outro clip, not at the main song's own natural end.

Fixed by giving the Plan its own `planEndCtxTime` (the ctx-time everything
scheduled by that call finishes, whether or not there's a real
destination) and checking that instead — `destStartCtxTime` still exists
and is still `null` exactly when there's no destination, but is no longer
used as a stand-in for "has this plan fired" outside of that case.

### Also fixed this round, same "mislabeling" family of bug

- **Self-transition**: `AddAudio.jsx`'s `derivedType` computation
  (`leftId && rightId ? 'transition' : ...`) never checked
  `leftId !== rightId` — with exactly one real reference song in the
  library, `detectMatch`'s independent left/right correlation can
  legitimately match that same song on both sides (e.g. an outro clip
  that still carries a fair amount of the original), which then read as a
  genuine two-song Transition from a song into itself. Reported directly:
  a real outro upload, saved and played back this way, sounded like the
  song "doubling up". Fixed with an explicit, un-auto-resolved error
  state (`sameSongBothSides`) — which single side is correct isn't
  decidable from the scores alone, so the DJ picks by hand rather than one
  detector score silently winning over the other.
- **Start→Intro (and general Outro/Intro) drag-connect validity**:
  `isValidConnection` (`PerformPage.jsx`) let Start connect to a song's
  Intro socket, and a song's Outro connect to End, with no check that a
  real produced edge existed for it — unlike Transition, which already
  required one. Fixed by adding the same `introEdgeFor`/`outroEdgeFor`
  existence checks Transition already had.
- **The Add Audio preview's own bracket label** (`TransitionPreviewPlayer.jsx`)
  unconditionally read "Transition · …" regardless of which side(s)
  actually matched — the same mislabeling class of bug, just in the
  preview screen rather than live playback. Now derives Transition/
  Intro/Outro the same way `AddAudio.jsx`'s own `derivedType` does.

### Status

**Implemented and verified** via the instrumented-`AudioBufferSourceNode`
Playwright technique established earlier in this doc, against real
synthetic WAV files: outro clip-start offset, intro clip-end trim, no
early main-deck cutoff, no overlapping/duplicate sources, correct
`setEnded` timing, and the scrub bar's fragment-phase light-up all
confirmed directly. Not re-verified: real-world detection accuracy of
`leftClipStartSec`/`rightClipEndSec` against an actual produced outro/
intro render (only synthetic, non-overlapping test audio was available
here) — the math mirrors the already-shipped `leftOutSeconds`/
`rightInSeconds` derivation exactly (same correlation lag, solved for the
other timeline), but a real produced clip is the only way to fully close
this out.

## 9. Round 5 — real produced audio changed the shape of the detection problem

§8's own "not re-verified against a real produced render" gap got closed
this round — the DJ supplied two real files (`regular.mp3`, a plain
reference master; `with_outro.mp3`, the same song with a produced outro)
directly. Ground truth, established independently of any detection code by
a raw zero-lag sample comparison across the whole pair: the two files are
byte-for-byte identical (relative RMS difference near the decode noise
floor) for the first **~91 seconds**, then diverge sharply for the rest —
matching the DJ's own estimate ("~1:33") closely.

### Confirmed bug: the old detector's whole premise didn't match real uploads

`detectMatch` (the auto-detect-which-song matcher, §1's original design)
only ever compared the dropped file's first/last `EDGE_SECONDS` (10s)
against a candidate's tail/head. Against the real pair, this reported the
divergence at **2:53** — 82 seconds off the true ~91s point, an error far
too large to be the correlation's own ~50ms window resolution. Root cause:
the algorithm assumed a produced upload is a short clip beginning right at
the splice — real uploads turned out to commonly be a **full-length
re-export of the whole song** with the splice embedded 90+ seconds in, a
shape a fixed 10-second edge window can never find a match inside.

### The rewrite: scan for the actual divergence, don't assume where it is

`audioDetect.js`'s `detectMatch` (and its exclusively-used support code —
`fetchEdgesRanged`, `headEnvelope`/`tailEnvelope`, `EDGE_SECONDS`,
`MATCH_THRESHOLD`) is gone, replaced by `detectSpliceForKnownSongs`. Two
changes, not one:

1. **No more auto-detecting WHICH song.** Direct instruction: the
   auto-match-across-the-whole-library step was unreliable enough that the
   DJ now picks the type (Transition/Intro/Outro) and the song(s) by hand,
   *before* dropping the file (`AddAudio.jsx`'s new segmented type picker +
   `SongPicker`s, gated so the Dropzone itself only appears once the
   song(s) are chosen). This also makes the previous round's
   `sameSongBothSides` ambiguity structurally impossible for a Transition
   (two independent pickers, not one detector guessing both sides from the
   same file) — the check stays as a plain defensive guard, not a
   detection-derived judgment call anymore.
2. **A real divergence scan for the splice TIMECODE**, now that WHICH
   song is a given, not a guess. `scanForwardDivergence` (i) coarsely
   correlates the probe's own leading ~20s against the reference's
   **entire** duration (not just its tail) to find where the probe's own
   t=0 aligns — commonly 0 for a full re-export, but not assumed to be;
   (ii) walks forward from there comparing windowed relative-RMS
   difference until it's *sustained* above threshold for a full second
   (guards against one transient — a drum hit landing slightly out of
   phase after a lossy re-encode — reading as the splice); (iii) refines
   the ~50ms-resolution boundary down to individual-sample precision via a
   short run of consecutively-elevated absolute difference. Intro
   detection (destination's real opening sits at the CLIP's own end, not
   its start) reuses the exact same forward-scanning function on
   time-reversed copies of both buffers (`reversedBuffer`) rather than a
   second hand-written mirror-image implementation — one scan to keep
   correct, not two that could quietly drift apart. `leftOutSeconds`/
   `leftClipStartSec`/`rightInSeconds`/`rightClipEndSec` keep their exact
   established meanings (§8) — only how they're computed changed, so
   nothing downstream (`AddAudio.jsx`'s save, `audioEngine.js`) needed to
   change shape.

Re-run against the real pair: **91.75s** (vs. ~2:53/173s before), a
0.16-second difference from the independent ground-truth check. Confirmed
via a direct splice-and-diff test (exactly the DJ's own requested
verification method): render `regular[0:leftOutSeconds] +
with_outro[leftClipStartSec:end]` and compare it, sample-for-sample,
against the real `with_outro.mp3` in full — relative RMS difference stayed
under 0.008 for every 2-second window across the entire ~192s track except
one brief transient exactly at the splice boundary (0.27 for that single
2s window, still far short of "unrelated audio"), confirming the detected
point is genuinely where the two streams cross, not merely plausible.

### Terminology followed the same correction as §8's mechanics

Direct feedback: a detected cue point on an Outro/Intro edge was labeled
"OUT"/showing the wrong word, because the UI's wording had never caught up
to §8's "an outro has no out point, an intro has no in point" correction —
it kept calling the Outro's own divergence marker an "out point" even
though §8 already established the main deck's real out-point concept
doesn't apply there. Fixed with a consistent rename, not a special case:
a Transition has a real early cue on both sides (OUT on the left, IN on
the right — unchanged). An Outro has no real out point on the left song,
but does have a real moment worth marking — where you enter the outro's
own new material — so it reads **IN**. An Intro has no real in point on
the destination, but has a real moment worth marking too — where you exit
the intro's own material into the destination — so it reads **OUT**. Also
consolidated to one player showing this precisely (a labeled tick +
timecode chip, not a translucent region alone) rather than a second, lower-
fidelity duplicate display elsewhere on the page — direct instruction.

### Confirmed bug found alongside all this: the live pulse never fired for Outro links at all

While restyling the graph's live-mixing pulse to match TouchDesigner's own
wire convention (confirmed via its UserGuide, not guessed: TD shows an
animated dashed line — not literal arrow shapes — to indicate active data
flow between nodes), found that the pulse had never worked for an
Outro-wired link in the first place, independent of anything else in this
round. `GraphPane.jsx` draws two separate edge families: real produced
Transitions (which set `animated: isActive && mixingEdgeId === e.id`
correctly), and a second family of synthetic "active link" edges for
plain None/Outro/Intro wiring, which never set `animated` at all — and
even if it had, that family's own edge `id` is a synthesized
`'link-<songId>-<type>'` string that never matches `mixingEdgeId` (which
holds the real underlying produced-edge id). Fixed by wiring `animated:
o.type === 'outro' && mixingEdgeId === o.edgeId` on that branch — a plain
None link still never animates (no produced audio, nothing to mix into).

### Node graph performance

Investigated directly (Chrome DevTools tracing via Playwright, both the
dev server and a production build): idle CPU is negligible with no
always-on `requestAnimationFrame` loop running when nothing is playing;
a sustained node-drag runs close to 60fps (~16.5ms average frame time, no
frames over 33ms) with no runaway loop, no unstable `nodeTypes`/`edgeTypes`
identity (a well-known React Flow foot-gun — confirmed absent, both are
declared module-level), and memoized derived props (`placedSongs`,
`positions`, etc., PerformPage.jsx) correctly scoped so a once-a-second
session tick doesn't force a full rebuild. No specific bug was found or
fixed here — this is an honest "not reproduced in this environment"
finding, not a confirmed-fine verdict: a real user's own hardware, browser,
or a specific interaction not covered by this profiling pass could still
be genuinely slower, and would need a concrete repro (ideally a screen
recording or the specific gesture that lags) to pin down further.

### Status

**Implemented and verified** for detection accuracy (a real produced pair,
not synthetic audio — the gap §8 explicitly left open), the manual
type/song picker, the IN/OUT terminology fix, and the graph pulse bug.
Node graph performance remains an open item pending a concrete repro from
the DJ's own environment.

## 10. Round 6 — live position display froze during a real fragment, then redesigned around a continuous span (implemented)

Reported directly, twice, against real produced audio (a real song into a
real outro): the bottom player bar and the graph node's own progress text
both showed the main song's own duration twice over (e.g. "3:12 / 3:12")
for the *entire* time the outro was actually sounding — reads as "still
playing the original," "the playhead stays frozen." §7 had already wired
`getPlaybackPosition`/`usePlaybackFrame` into `Playhead` and
`CountdownRing`; `node-position`'s own text was the one place §7
explicitly left on the once-a-second value (see its own note, now
corrected above) — and, it turned out, so was the bottom player bar's
`player-bar-time` text, which never went through this doc's Layer B at
all despite reading the same way. Both instead derived from
`nowSong.durationSec - session.timeLeft`.

**Root cause, confirmed by reading the tick loop (`App.jsx`), not
assumed:** once a Plan's fragment is scheduled, `engine._current` stays
`kind: 'main'` — correctly, by design (see §7's premature-`consumePlan`
fix) — until the fragment itself finishes. But the tick's own
`hasRealMainDeck` branch treats `_current.kind === 'main'` as "the main
deck is genuinely still sounding" and keeps computing
`elapsedNow = engine.getMainElapsed(...)` against it — which, once
`ctx.currentTime` moves past the deck's own real duration while the
fragment plays, exceeds `duration`, so `timeLeft = Math.max(0, duration -
elapsedNow)` clamps to exactly `0` and stays there for the fragment's
entire real length. `elapsed = duration - timeLeft` in the two display
sites above then reads as the song's own full duration, frozen, matching
the report exactly.

**First fix (superseded below, kept as a stepping stone):** read
`getPlaybackPosition()` directly (Layer B, already correct) instead of
`session.timeLeft` for both display sites. This closed the freeze — the
display now correctly showed the fragment's own separate elapsed/duration
once it started (e.g. "0:01 / 0:06" for a 6s outro) — but introduced a
new, real complaint: the total visibly *reset* the instant the fragment
took over (8s song → suddenly "0:06"), which reads as its own kind of
"something weird just happened," and doesn't match how a DJ actually
thinks about a wired ending — **by the time playback reaches a node, its
own destination and duration are already decided**, so the displayed
total should already reflect that, not jump to a shorter number once the
fragment audibly starts.

**Real fix — `getPlaybackPosition` redesigned around one continuous span:**
rather than two phases where entering `'fragment'` restarts the clock,
`'main'` now keeps reporting the *same* `songId` straight through any
fragment(s) scheduled off it, with `durationSec` extended to cover them
and a new `fragmentBoundariesSec` array (one entry per chained fragment —
an outro immediately followed by an intro is two) marking where each
begins on that same combined timeline:

```
def getPlaybackPosition():
    if current.kind == 'main':
        elapsedSec = current.offsetSec + max(0, now - current.startCtxTime)
        if a Plan with fragmentSteps is scheduled off this deck:
            durationSec = current.offsetSec + (plan.planEndCtxTime - current.startCtxTime)
            fragmentBoundariesSec = [current.offsetSec + (step.startCtxTime - current.startCtxTime) for step in plan.fragmentSteps]
            return { phase: 'main', songId, elapsedSec, durationSec, fragmentBoundariesSec }
        return { phase: 'main', songId, elapsedSec, durationSec: current.buffer.duration, fragmentBoundariesSec: [] }
    if current.kind == 'silent': ...  # same shape, no Plan possible against a silent deck
    if current.kind == 'clip':        # the reactive handleHandoff path only — see below
        return { phase: 'fragment', elapsedSec: now - current.startCtxTime, durationSec: current.durationSec }
    return { phase: 'silence' }
```

This works with **no extra bookkeeping for `elapsedSec` at all**: a
fragment's own node is scheduled to start at the exact `ctx` time the
main deck's own node stops (`triggerCtxTime`, already computed in
`scheduleHop`), so `now - current.startCtxTime` already counts up
seamlessly straight through that boundary — only `durationSec` needed to
grow to match. Because `scheduleHop` runs from very early in a song's own
playback (the tick calls it the first time `hasRealMainDeck` is true, not
gated by any lookahead window), the extended total is typically already
correct well before the fragment starts, not just once it does — verified
directly (real audio: an 8s song, a real outro file with `clipStartSec`
trimming it to 6s real content): the bar read **"0:14" starting a few
seconds into the song**, stayed "0:14" through the crossing with no jump,
and elapsed counted "0:08 → 0:10" continuously rather than resetting.

`'fragment'` survives as its own phase *only* for `handleHandoff`'s
reactive path (`_current.kind === 'clip'`) — used when Now Playing has no
real main-deck audio of its own to schedule a Plan against, so there's no
surrounding song's own timeline for a fragment to extend. This path had
no case in `getPlaybackPosition` at all before this round (reported
'silence' for a real fragment genuinely playing) — closed alongside the
main fix by having `_playClipToEnd` record the clip's own real playable
`durationSec` (offset/`clipEndSec` already applied) on `_current`.

**Consumers updated:**
- `Playhead` (`SequencePane.jsx`): the fill's `elapsedSec/durationSec`
  formula didn't need to change at all — it was already computing a
  percentage of *some* duration, and that duration now correctly spans
  the fragment. What did change: the colored "cue zone" — previously a
  static `cuePct` prop, computed once in `PerformPage.jsx` from
  `committedEdge.outSeconds`, and Transition-only (an Outro was said to
  have "no early cue point," which was true but conflated with "no
  boundary worth marking") — now reads `fragmentBoundariesSec` itself,
  every frame, and draws a zone from the first boundary to the end
  regardless of hop type. The "lights up on crossing" flash now triggers
  off `elapsedSec` crossing that boundary instead of a phase change.
  Dragging the scrubber no longer blanks the zone for the drag's duration
  (a `lastZoneRef` remembers it across drag-only `setDisplayPct` calls
  that don't recompute one).
- `PlayerBarElapsed`/`PlayerBarTotal` (new, `PerformPage.jsx`,
  replacing inline `<span>{fmtTime(elapsed)}</span>` markup) and
  `NodePosition` (new, `GraphNodes.jsx`, replacing `node-position`'s old
  context-value text): both already matched `pos.phase === 'main' &&
  pos.songId === songId` (or the rare reactive `'fragment'` case) — no
  change needed once `getPlaybackPosition` itself carried the combined
  duration, since both were already reading it directly by this point.
- `seekPlayhead` (`PerformPage.jsx`): the bar's 100% is no longer just
  `nowSong.durationSec`, so `fraction * nowSong.durationSec` alone would
  land a drag past the boundary somewhere in the *already-played* tail of
  the main song — silently wrong, not a crash. Now reads the combined
  duration/boundary off a ref mirrored every frame
  (`latestPosRef`, fed by its own `usePlaybackFrame` subscription) and
  clamps the resulting offset to the boundary — there's no real seek
  target inside a scheduled fragment (a one-shot node, not a seekable
  deck), so landing past it just parks at the edge of the handoff.
- `CountdownRing`: unaffected — its own `cueOffsetSec` prop (a
  Transition's `outSeconds`) is independent of `durationSec`; once
  `elapsedSec` passes it during a fragment the remaining-time computation
  goes negative, but `clamp01` already floors that to the same "fully
  drained" ring state it showed right before the boundary, not a new
  broken state.

`NowPlayingContext` (`GraphNodes.jsx`) no longer carries `elapsed`/
`duration` fields at all — `NodePosition` reads the engine's clock
directly, the same `usePlaybackFrame` pattern `CountdownRing` already
used, rather than receiving a value threaded through
`GraphPane`/`PerformPage` props. Closes the stale-value class of bug at
its root for that display rather than patching the value it was fed.

Verified end to end against real audio both times (the freeze fix, then
the continuous-span redesign): a real ~8s main song into a real produced
outro file with a genuine `clipStartSec` trim, confirming — via the
*displayed* numbers, not just reading the scheduling code — that the
audio itself was always being correctly trimmed underneath (the freeze
bug was a display-only bug; `clipStartSec` handling in `scheduleHop`/
`handleHandoff` predates this round and was not touched by it), and,
separately, that a drag into the marked fragment zone clamps rather than
seeking somewhere unrelated.

### Confirmed fine, not touched

- **`clipStartSec`/`clipEndSec` scheduling itself** (`scheduleHop`,
  `handleHandoff`, both already reading `edge.clipStartSec`/`clipEndSec`
  per §8) — this round only changed how the *result* of that scheduling
  is displayed, never the scheduling itself. If a specific already-saved
  edge's own audio still doesn't sound trimmed once the display is
  accurate, that specific edge is the thing to check (does it actually
  have a `clipStartSec` stored? — depends on whether detection found a
  confident divergence point against that particular pair of files,
  same as any other detection result), not this scheduling code.

## 11. Round 7 — an outro DOES have a real out point after all; §8 reversed (implemented)

Direct correction, reversing part of §8: reported directly, against real
audio and a live screenshot (Round 6's own combined-total display working
exactly as designed) — a plain ~3-minute song with a produced outro
attached was showing a combined total of **4:52**. §8 had deliberately
made an Outro's main deck always play to its own full natural duration,
reasoning (also from a direct DJ correction, at the time) that truncating
the song being left "would just be losing the last few seconds... for no
reason." Confronted with the actual number that produces once a real
outro is involved, the direct instruction reversed: **the main deck
should cut at the outro's own real splice point and the outro's own new
material should pick up immediately after — "cut off part of the
original (at the in point) and then append the outro to it."**

**Why this doesn't reopen the bug §8 itself fixed:** §8's own "old
behavior, and the real bug in it" section is worth re-reading carefully —
the pre-§8 code *also* cut the main deck early at `outSeconds`, but at the
time `edge.clipStartSec` didn't exist yet, so the outro clip played from
its own raw `t=0` — replaying the reference song's own overlapping tail a
*second* time (once on the truncated main deck, once again at the head of
the untrimmed clip). §8's fix addressed that specific double-count by
restoring the full-duration main deck and inventing `clipStartSec` to trim
the clip's own duplicated lead-in instead. This round doesn't touch
`clipStartSec` at all — it *adds* an early main-deck cutoff back on top of
the now-existing `clipStartSec` trim, and the two are not independently
measured: `detectSpliceForKnownSongs`' one `scanForwardDivergence` scan
(`audioDetect.js`) produces `leftOutSeconds` (the split point on the
*reference song's* own timeline) and `leftClipStartSec` (the same real
instant, on the *dropped clip's* own timeline) together, from the same
correlation. Cutting the main deck at `outSeconds` and starting the clip
at `clipStartSec` therefore splices at the exact same real-world moment
from both sides — no gap, and (unlike the pre-§8 bug) no double-counted
material, since the clip's own duplicate lead-in is still trimmed off
before it ever plays. This is the same mechanic a Transition edge already
used the whole time (cut the main deck at `outSeconds`, the clip's own
`inSeconds`/offset picks up the other side) — Round 7 makes Outro
consistent with it instead of a special case.

**Changed:**
- `audioEngine.js`'s `buildHopDecision` — both outro branches (an End-Set
  outro, and a cut hop ending in outro before a destination) now use
  `edge.outSeconds` (when a confident value was detected) as `cueOffsetSec`
  instead of unconditionally `currentBufferDurationSec`. Falls back to the
  full duration exactly when there's no detected `outSeconds` to cut at
  (no reference master, or detection found nothing) — same graceful
  degradation used everywhere else a detected value might be missing, not
  a hard requirement.
- `core.js`'s `transitionTriggerElapsed` (the reactive fallback path, for
  when Now Playing has no real audio to schedule a Plan against) — now
  also returns an outro-ending hop's own `outSeconds` as the trigger point,
  mirroring the Transition branch already there. Safe to look the edge up
  by a plain `edgeId` match (no `nowPlayingId`-based fallback scan needed):
  `playlistNextHop` is the only place that ever constructs
  `ending: 'outro'`, and it always sets `edgeId` to that same outro's own
  id right alongside it.
- `PerformPage.jsx`'s `mixingEdgeId` computation (when to start pulsing
  the graph's own edge / showing the "mixing into" preview) now reads
  `fragmentEdge.outSeconds` for either an Outro or a Transition uniformly,
  rather than being conditioned on `committedEdge` (Transition-only).

**What this means for the displayed total** (§10's own continuous-span
design is unaffected in shape, only in what number it now computes): for
an outro edge with `outSeconds`/`clipStartSec` both detected, the combined
total is now `outSeconds + (the outro clip's own real, clipStartSec-
trimmed duration)` — typically much shorter than the song's own full
length, not longer than it. Verified against real audio: an 8s main song
with an outro edge set to `outSeconds: 5` (`clipStartSec: 2` on a real 8s
outro file, so 6s of real new content) shows a combined total of **0:11**
throughout — never 0:14 (the old full-song-plus-outro number) — with
elapsed already past the old 8s mark by t=6s (confirming the main deck
really did stop at 5s, not 8s) and continuing to advance with no reset.

### Open question, not resolved here

An outro/edge with **no** detected `outSeconds` (no reference master
uploaded, or detection genuinely found nothing) still falls back to
playing the main deck to its own full natural duration — the pre-Round-7
behavior. Whether that fallback is still the right default, now that a
*confident* detection cuts early, or whether a produced-but-undetected
outro should behave some other way, wasn't part of this round's direct
instruction and is left as-is rather than guessed at.

## 12. Round 8 — "the outro switch is glitchy sometimes" traced to a random draw, plus seeking into the zone (implemented)

Direct report: *"the outro switch is quite glitchy sometimes too. It needs
to work literally all the time and seamlessly at that."* Alongside it, a
list of playhead/UX items — no pulse on switchover, persistent (not
flickering) highlighting, clicking the highlighted area to actually seek
into the outro, a persistent selected-output indicator in place of the
countdown ring, a Start play button that survives being used, and a
restart that re-picks the output. (*"The dotted animation doesn't work
just leave it alone."* — out of scope, untouched.)

### Spec, written first (from the user's own statements)

- **S1** By the time playback reaches a node, its output is **set in
  stone** — the same output every read, until the node is restarted.
- **S2** Restarting a node re-picks its output (the one place a re-roll is
  correct).
- **S3** The displayed total never changes mid-playback for any reason —
  a tick, a re-render, a seek, or the fragment actually starting.
- **S4** The fragment highlight is persistent; moving the playhead never
  blanks or flickers it.
- **S5** Clicking inside the highlight plays the clip **from that point**,
  not from the clip's start and not "playhead there, audio elsewhere."
- **S6** No flash/pulse on switchover.
- **S7** The Start node's play button is always present.

### Findings

- **F1 — confirmed bug, and the root cause of "glitchy sometimes."**
  `playlistNextHop` (core.js) draws with `Math.random()`. Nothing froze
  its result, so it was re-rolled **on every tick, on every render that
  read `queueHead`, and again at hop time**. For a node with both a None
  and an Outro output wired, the outro therefore fired on a coin flip —
  and the *same* mechanism independently explains the shifting total (S3)
  and the flickering highlight (S4). One cause, three reported symptoms.
  Fixed by `commitHopFor(session, songId)` + `session.committedHop`: the
  decision is frozen once, at song start (`startSet`, `goBack`,
  `advanceSession`, `syncSessionFromFiredPlan`, and backfilled on resume
  in `togglePlaying`), and every reader consumes that stored value instead
  of drawing again. Restart re-rolls by construction, since `startSet`
  calls `commitHopFor` — S2 falls out of the same change rather than
  needing its own mechanism.
- **F2 — confirmed bug.** `cancelPlan` called `stop()` on every pending
  node including ones already sounding, so cancelling a plan mid-fragment
  cut real audio dead. Now skips steps whose `startCtxTime` has already
  passed unless called with `hard`.
- **F3 — confirmed bug.** `cancelPlan` never rescinded the **deck's own**
  scheduled stop, so a cancelled plan could silently kill the set: the
  main deck stopped at the splice with nothing arriving to replace it. The
  plan now carries `deckSource`/`deckNaturalEndCtxTime` and cancelling
  re-schedules the stop back out to the deck's natural end.
- **F4 — missing feature (S5).** Seeking into the highlighted zone had no
  implementation at all: `seekMain` only ever moves the main deck, so a
  drag into the zone parked the playhead at the boundary while the song
  quietly kept sounding — the same display-vs-sound disagreement §7
  already recorded once. Added `seekIntoFragments`, which arms the
  remaining chain from `now`, skipping into whichever fragment contains
  the point. `fragmentWindow` was extracted so the seek and the scheduled
  path can't disagree about where a clip's real content begins.
- **F5 — confirmed bug, found by testing F4's own fix.** The first
  `seekIntoFragments` reported position off the clip's own short span, so
  clicking into the zone visibly collapsed the total (11s → 6s) — a fresh
  violation of S3 introduced by the fix for S5. The seeked clip now
  carries the combined timeline with it (`spanStartCtxTime`,
  `spanDurationSec`, `fragmentBoundariesSec`) and `getPlaybackPosition`
  reports it as phase `'main'` on that one continuous span. The isolated
  `'fragment'` phase remains only for the reactive `handleHandoff` path,
  which genuinely has no surrounding timeline.
- **F6 — confirmed bug, same origin as F5.** After seeking into the zone
  there is no main deck, so scrubbing back *into the song* hit
  `seekMain`'s `kind !== 'main'` guard and silently did nothing.
  `seekPlayhead` now restarts the deck at that offset and re-arms the hop.

S4/S6 were UI-side: the `.lit` flash and its keyframes were deleted
outright, and `Playhead` now only ever replaces a known zone with another
real one (`if (zone) lastZoneRef.current = zone`), so a drag can't blank
it. S7 was a stale `canPlay={!hasStarted}` gate. `CountdownRing` was
replaced by `SelectedOutputDot`, driven by `committedHop` — which is why
it can be persistent at all: before F1 there was no stable answer to
"which output is selected" to show.

### Verified against real audio

An 8s song with an outro edge (`outSeconds: 5`, `clipStartSec: 2`):
`committedHop` stable across 8 samples and many forced re-renders, total
stable at 0:11, hop label stable; 12 restarts produced both possible hops;
no `.lit` ever applied; zone geometry byte-identical across a 5-step drag;
clicking at 8.8s of the 11s span landed at 9s (not the 5s boundary) and
kept advancing with the total unchanged; scrubbing back to 2s restarted
the song and re-armed the same 0:11 total.
