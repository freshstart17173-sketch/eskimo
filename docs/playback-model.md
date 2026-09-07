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

- **Back/previous control** (Finding 4) — needs the resume-vs-restart
  question answered before it's built.
- **Sample-accurate lookahead scheduling** (Findings 1 & 2) — the real fix
  for "playing the right audio at the right time"; a scheduler rewrite,
  not a contained patch. Tracked in `TODO.md`.
- **A real regression suite** (Finding 7) — scenarios in §2 above are
  written to be testable as stated, independent of whichever
  implementation ends up satisfying them.
