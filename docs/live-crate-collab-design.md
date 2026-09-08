# Shared live crate — correctness spec and design

Requested directly: a shareable link so producer friends can open Eskimo
Studio and contribute directly into a DJ's real library — not a stripped-
down submission form, the actual editor, live-synced.

This doc follows the correctness-check process: the spec below was
derived from first principles (what does multi-writer collaboration on a
DJ tool actually have to guarantee) before any schema or sync code was
written, specifically so the current sync layer's own known weakness
(whole-blob overwrite, described below) doesn't get silently extended
into a case where it's now guaranteed to be hit in practice.

## What exists today (so the gap is concrete, not assumed)

- `public.library` (Supabase): **one row per anonymous user**, RLS-scoped
  to `auth.uid()`. The entire `{songs, edges, session, venueName,
  playlists}` object is serialized and **overwritten wholesale** on every
  save — `App.jsx`'s 400ms-debounced effect calls `Store.pushRemote(data)`
  with the full current state every time, no partial/row-level writes at
  all.
- This has **zero multi-writer safety**, but it's never been exercised as
  a real multi-writer system — today it only ever matters for one person's
  own two tabs/devices, where "last save wins" occasionally overwriting
  your own slightly-stale other tab is a mild, rare annoyance. A shared
  crate guarantees this same mechanism gets hit constantly, by two
  *different* people, the moment more than one person has it open — the
  exact case the current design was never asked to survive.
- Real audio playback (`audioEngine.js`) is **entirely local, per-browser,
  never synced** — nothing about the current design touches this, and
  nothing proposed below should change that.

## Requirements, derived from first principles (before reading sync code)

Concrete scenarios a correct design must handle — each stated as "if X,
then Y, and specifically not Z":

1. **Two different new songs added at once** (DJ adds song A, friend adds
   song B, same moment) → both must survive. Neither write may be lost.
2. **Two different songs edited at once** (DJ renames A, friend re-tags B)
   → both survive independently.
3. **The same song edited by two people at once** (both drag song A to a
   different canvas position) → one position wins, but **only that one
   song's position** — a collision on A must never revert some unrelated
   field on B, or on A itself, that a whole-blob overwrite would silently
   drag along for the ride.
4. **A delete racing a reference to the deleted thing** (DJ deletes song A
   while a friend simultaneously wires a transition *from* A) → the system
   must end in a **consistent** state (no wire left pointing at a song
   that no longer exists) — not necessarily "the delete always wins," just
   never a dangling reference.
5. **Two people each add a different transition off the same socket at
   the same instant** (friend wires A→C, DJ wires A→D, both via a real
   drag-connect, within the same round-trip) → per the multi-output
   feature (already fixed this session), **both must survive**. This is
   the one scenario a naive client-side "read the array, append locally,
   write the whole array back" would get wrong even with per-row storage:
   whichever write lands second on the server overwrites the array the
   first write produced, silently losing the first contribution — the
   exact class of bug just fixed locally (`addTransitionConnection`), now
   reachable over the network unless the append itself is atomic at the
   database, not the client.
6. **A collaborator's connection drops mid-edit and later reconnects**
   (bad wifi at a venue) → must not corrupt shared state on reconnect, and
   must not silently discard newer state that arrived while offline
   without at least the possibility of noticing.
7. **A collaborator sees another's change without refreshing** — for this
   to be worth calling "live," a friend adding a song should appear for
   everyone else within roughly a second, not "whenever you next reload."
8. **A crate link is the credential** — anyone who has it can read and
   write; anyone who doesn't, can't. No signup step, matching the app's
   existing zero-friction, already-anonymous-auth posture.
9. **A crate is not a person's own solo library** — opening a crate link
   must never read from or write into the visitor's own personal library,
   and must never require them to have one. Leaving the crate must not
   leave their own separate library touched at all.
10. **Live playback safety — the one non-negotiable constraint.** Whatever
    the sync layer does, the actively-performing browser's own real-time
    transport state (`session.isPlaying`, `nowPlayingId`, `queue`,
    `timeLeft`, and everything `audioEngine.js` has already committed to —
    a scheduled hop mid-flight) must **never** be overwritten by an
    inbound remote update, from any collaborator, under any timing. A
    remote edit arriving mid-mix must not be able to desync what's
    actually sounding from what the UI or the scheduler believes is
    sounding. This holds regardless of how the open question below is
    resolved.

## The one real open question — not guessed at, needs a decision

The request was specifically **"contribute songs and audio"** — that's
narrower than "collaboratively wire the live set graph together," and the
two have very different risk profiles. This needs an explicit choice, not
an assumption, because it changes both the schema and the safety story:

**Option W1 — Share the library, keep wiring private.** The pool of
songs and produced edges (intro/outro/transition audio pieces — the raw
material) is shared and live-synced. Each collaborator's own
`activePlaylist` (how *they* currently have things wired/tested) stays
local to their own browser, never synced. The DJ freely pulls from the
shared pool into their own live graph whenever they want. A friend can
never touch the DJ's actual live wiring, even by accident — requirement
10 above becomes trivially true by construction, since wiring/session
never crosses the network at all. This is the direct, minimal-risk
implementation of what was literally asked for.

**Option W2 — Share everything, including the live graph wiring.** True
real-time collaborative set-building — anyone can rewire anyone's
transitions, live. Meaningfully more useful for building a set *together*
in the same room, but it means requirement 10 has to be actively enforced
rather than trivially true: the sync layer must merge inbound wiring
changes into local state without ever touching the fields the running
audio engine has already committed to, and a friend's stray edit can now
directly disrupt the DJ's actual live plan mid-build (not mid-performance,
since nothing here proposes syncing to a device that's actively running a
live set for an audience — but mid-*rehearsal* is a real case this app
exists for).

Recommendation: **W1** — it's what was actually asked for, it's meaningfully
less code and less new risk, and W2 remains a straightforward later
addition on the same schema (the wiring tables below are additive) once
W1 is live and the actual need for shared wiring has been felt rather
than assumed.

## Proposed schema (assumes W1; W2 adds the last two tables)

Moving off "one JSON blob per row" is required regardless of W1 vs. W2 —
it's what requirements 1-5 actually need. Real relational rows, not a
blob:

```sql
crates            (id text primary key,           -- random unguessable slug, e.g. nanoid(22)
                    created_at timestamptz)

crate_songs       (crate_id text references crates(id),
                    song_id text, title text, artist text, bpm numeric,
                    key text, duration_sec numeric, audio_url text,
                    cover_url text, x numeric, y numeric,
                    updated_at timestamptz,
                    primary key (crate_id, song_id))

crate_edges       (crate_id text references crates(id),
                    edge_id text, type text, l text, r text,
                    in_seconds numeric, out_seconds numeric, verified boolean,
                    primary key (crate_id, edge_id))

-- W2 only, additive:
crate_playlist_nodes (crate_id text references crates(id),
                       song_id text, start_mode text, start_edge_id text,
                       end_mode text, end_edge_id text, next_song_id text,
                       transitions jsonb,           -- append via RPC, see below
                       primary key (crate_id, song_id))
crate_playlist_meta  (crate_id text primary key references crates(id),
                       start_song_id text, start_mode text, start_edge_id text)
```

RLS: not `auth.uid()`-scoped like `library` — these tables are reachable
by anyone who supplies a valid `crate_id`, the same "the ID is the secret"
model the R2 bucket's already-public audio objects use. **This is a real,
deliberate security trade-off worth stating plainly**: whoever has the
link has full read+write, indefinitely, the same as an "anyone with the
link can edit" Google Doc — pasting the link somewhere public hands out
real access. The only remedy is generating a fresh crate id (there's no
"revoke this one person" short of that). Worth confirming this trade-off
is acceptable before building against it.

Requirement 5 (concurrent appends to the same song's `transitions` array,
W2 only) needs the append itself to be atomic **in the database**, not
read-modify-write on the client:

```sql
create or replace function append_transition(p_crate_id text, p_song_id text, p_entry jsonb)
returns void language sql as $$
  update crate_playlist_nodes
  set transitions = transitions || p_entry
  where crate_id = p_crate_id and song_id = p_song_id
    and not (transitions @> jsonb_build_array(p_entry));
$$;
```

Called as an RPC instead of a plain row update — this is what actually
satisfies requirement 5, not just storing the array in its own row.

## Sync mechanism

Supabase Realtime (`postgres_changes` subscriptions scoped to `crate_id`)
rather than polling — it's already the backend in use, and gives
requirement 7 (near-instant visibility) with no new infrastructure.
Inbound changes upsert/delete into local React state incrementally (one
song/edge at a time) — never a wholesale local-state replace, which is
what would reintroduce requirement 10's exact risk on the *receiving*
side even if writes are already safe.

## How this plugs into the existing app

- A crate is addressed via a URL (e.g. `?crate=<id>`), checked once at
  boot in `App.jsx`. In crate mode, `songs`/`edges` state is sourced from
  and written to the crate tables (+ realtime subscription) instead of
  the personal `library` row — completely separate code path from a
  personal library's sync, satisfying requirement 9 by construction
  rather than by careful merging.
- `session` (playback +, under W1, `activePlaylist`) stays exactly as
  local as it is today — `Store.pushRemote`'s existing behavior for a
  personal library is untouched; crate mode simply never includes
  `session` in what it syncs. This is what makes requirement 10 hold
  under W1 without any new enforcement code at all.
- The existing `isDemo` guard (a real upload/add-song clears the example
  set first) applies the same way inside a crate — a crate starts empty
  like a fresh personal library would, not seeded from the example set.

## Status

**Implemented, scope W1.** The migration (`crates`/`crate_songs`/
`crate_edges`, RLS policies, realtime publication) is live on the real
Supabase project. `src/crateStore.js` holds the row↔app-object mapping and
the create/fetch/push/delete/subscribe calls; `App.jsx` wires it in as a
completely separate code path from the personal library (crate mode
detected once via `?crate=<id>`, never touches `Store`/`library` at all)
and does the local song/edge diff-push (reference-equality against the
previous render, so every existing `setSongs`/`setEdges` call site — drag,
Autoarrange, Autoconnect, undo, upload — is covered automatically without
being touched individually) plus a remote-origin tracking set so an
inbound realtime change doesn't immediately echo back out. Settings gained
a "Shared crate" section: start one (seeds it from the current library,
then reloads into crate mode), copy the link, or leave. `session`
(playback + graph wiring) is never sent to a crate — confirmed by
construction, not by a runtime guard: the code path that pushes to the
crate only ever touches `songs`/`edges` state, and the debounced-save
effect that touches `session` writes it to a crate-scoped **local**
`localStorage` key, never to Supabase, whenever `CRATE_ID` is set. The
"Clear all data" and "Restore from a backup" actions are disabled inside
a crate (both would otherwise wipe the shared pool for every collaborator,
not just the local browser) — "Leave this crate" is offered instead.

**Verified:** the database layer directly — insert/read/update/delete
against `crate_songs` via the real anon key over plain REST (curl,
bypassing the browser entirely) confirmed the RLS policies genuinely allow
anonymous read+write scoped by crate id, cascade-delete works, and the
schema round-trips correctly. The non-crate personal-library path was
re-run through the full existing smoke test after these changes with zero
regressions.

**Not verified end-to-end in this environment, and worth knowing why:**
this development sandbox's outbound network goes through a proxy that
explicitly does not support WebSocket upgrades — Supabase Realtime's
transport — and browser-originated HTTPS requests to the Supabase project
were failing at the proxy layer in a way plain `curl` from the same
sandbox wasn't (documented, unresolved after following the environment's
own remediation steps). So: the create-crate-from-Settings flow, a second
browser actually receiving another collaborator's change live without a
reload, and the realtime subscription's reconnect behavior have **not**
been exercised against a real running instance of the app — only reasoned
through via code review and the direct database-layer verification above.
These should be smoke-tested against the real deployed site (two browser
tabs/devices, one crate link) before relying on this for an actual
session with producer friends.
