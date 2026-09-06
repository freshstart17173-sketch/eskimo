// Pure-logic unit tests for core.js — no React, no browser APIs, just the
// data-model functions exercised against the sample graph the file itself
// ships for exactly this purpose (sampleSongsForTests/sampleEdgesForTests).
// Run with `npm test` (Node's built-in test runner, no extra dependency).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleSongsForTests, sampleEdgesForTests, emptySession, END,
  getVisibleEdges, inOutCounts, transitionCandidates, cutCandidates, queueTailId,
  pickAutoplayNext, advanceSession, removeSongCascade, removeQueueItem, libraryRows,
  transitionTriggerElapsed, CROSSFADE_LOOKAHEAD_SEC,
  mockDuration, pseudoCuePoints, pickDetectedSongs, hashString,
  clamp, fmtTime, fmtBytes,
} from './core.js';

// Sample graph: intro->hd -[e2]-> cb -[e4]-> gs -[e6]-> lr
//                                    cb -[e5:outro]      gs -[e13]-> wr
//                                                         gs -[e14:outro]
// every edge in the fixture is verified=true.

test('getVisibleEdges only keeps verified edges', () => {
  const edges = [...sampleEdgesForTests(), { id: 'x', type: 'transition', l: 'lr', r: 'wr', verified: false }];
  const visible = getVisibleEdges(edges);
  assert.equal(visible.length, sampleEdgesForTests().length);
  assert.ok(!visible.some(e => e.id === 'x'));
});

test('inOutCounts counts only verified, direction-appropriate edges', () => {
  const edges = sampleEdgesForTests();
  const gs = inOutCounts(edges, 'gs');
  // in: cb->gs (e4). out: gs->lr (e6) + gs->wr (e13) + gs's own outro (e14) —
  // outCount only excludes intro-typed edges, so an outro still counts as an out.
  assert.equal(gs.inCount, 1);
  assert.equal(gs.outCount, 3);
});

test('transitionCandidates returns the built-transition edges out of a song, honoring the exclude set', () => {
  const visible = getVisibleEdges(sampleEdgesForTests());
  const fromGs = transitionCandidates(visible, 'gs', new Set());
  assert.deepEqual(fromGs.map(e => e.r).sort(), ['lr', 'wr']);

  const excluded = transitionCandidates(visible, 'gs', new Set(['wr']));
  assert.deepEqual(excluded.map(e => e.r), ['lr']);
});

test('cutCandidates offers every song not already excluded', () => {
  const songs = sampleSongsForTests();
  const all = cutCandidates(songs, new Set());
  assert.deepEqual(all.sort(), Object.keys(songs).sort());

  const withoutHd = cutCandidates(songs, new Set(['hd']));
  assert.ok(!withoutHd.includes('hd'));
  assert.equal(withoutHd.length, Object.keys(songs).length - 1);
});

test('queueTailId follows the queue tail, or Now Playing when nothing is queued, or null past an End Set', () => {
  assert.equal(queueTailId('hd', []), 'hd');
  assert.equal(queueTailId('hd', [{ id: 'cb', mode: 'transition' }]), 'cb');
  assert.equal(queueTailId('hd', [{ id: 'cb', mode: 'transition' }, { id: END }]), null);
});

test('pickAutoplayNext prefers a built transition, and honors transitionOnly at a dead end', () => {
  const songs = sampleSongsForTests();
  const visible = getVisibleEdges(sampleEdgesForTests());
  const pick = pickAutoplayNext(songs, visible, 'hd', false);
  assert.equal(pick.id, 'cb');
  assert.equal(pick.mode, 'transition');

  // wr has no outgoing transition — a dead end
  const strict = pickAutoplayNext(songs, visible, 'wr', true);
  assert.equal(strict, null);
  const loose = pickAutoplayNext(songs, visible, 'wr', false);
  assert.ok(loose && loose.mode === 'cut');
});

test('advanceSession promotes the queue head', () => {
  const songs = sampleSongsForTests();
  const session = { ...emptySession(), nowPlayingId: 'hd', queue: [{ id: 'cb', mode: 'transition' }], timeLeft: 0, isPlaying: true };
  const next = advanceSession(session, songs, getVisibleEdges(sampleEdgesForTests()));
  assert.equal(next.nowPlayingId, 'cb');
  assert.equal(next.queue.length, 0);
  assert.equal(next.timeLeft, songs.cb.durationSec);
});

test('advanceSession ends the set on reaching End Set', () => {
  const songs = sampleSongsForTests();
  const session = { ...emptySession(), nowPlayingId: 'cb', queue: [{ id: END, ending: 'cut' }], isPlaying: true };
  const next = advanceSession(session, songs, getVisibleEdges(sampleEdgesForTests()));
  assert.equal(next.setEnded, true);
  assert.equal(next.isPlaying, false);
  assert.equal(next.queue.length, 0);
});

test('advanceSession with autoplay on and an empty queue picks a next song instead of stopping', () => {
  const songs = sampleSongsForTests();
  const session = { ...emptySession(), nowPlayingId: 'hd', queue: [], isPlaying: true, autoplay: true };
  const next = advanceSession(session, songs, getVisibleEdges(sampleEdgesForTests()));
  assert.equal(next.nowPlayingId, 'cb'); // hd's only built transition
  assert.equal(next.autoHistory.length, 1);
  assert.equal(next.autoHistory[0].id, 'cb');
});

test('advanceSession with autoplay off and an empty queue stops the set', () => {
  const songs = sampleSongsForTests();
  const session = { ...emptySession(), nowPlayingId: 'hd', queue: [], isPlaying: true, autoplay: false };
  const next = advanceSession(session, songs, getVisibleEdges(sampleEdgesForTests()));
  assert.equal(next.setEnded, true);
  assert.equal(next.isPlaying, false);
});

test('transitionTriggerElapsed uses a committed transition\'s real cue point over full duration', () => {
  const edges = [{ id: 'e2', type: 'transition', l: 'hd', r: 'cb', verified: true, outSeconds: 150 }];
  const withCue = transitionTriggerElapsed({ id: 'cb', mode: 'transition', edgeId: 'e2' }, edges, 214);
  assert.equal(withCue, 150);

  const noCueEdge = [{ id: 'e2', type: 'transition', l: 'hd', r: 'cb', verified: true }]; // outSeconds not set
  assert.equal(transitionTriggerElapsed({ id: 'cb', mode: 'transition', edgeId: 'e2' }, noCueEdge, 214), 214);

  assert.equal(transitionTriggerElapsed({ id: 'cb', mode: 'cut' }, edges, 214), 214);
  assert.equal(transitionTriggerElapsed(null, edges, 214), 214);
  assert.ok(CROSSFADE_LOOKAHEAD_SEC > 0);
});

test('removeQueueItem drops one hop and recomputes its successor against the new predecessor', () => {
  const visible = getVisibleEdges(sampleEdgesForTests());
  // hd -(cb, via e2)-> cb -(gs, via e4)-> gs -(wr, via e13)-> wr
  const queue = [
    { id: 'cb', mode: 'transition', edgeId: 'e2' },
    { id: 'gs', mode: 'transition', edgeId: 'e4' },
    { id: 'wr', mode: 'transition', edgeId: 'e13' },
  ];
  // remove the middle hop (gs) — wr's new predecessor is cb, which has no
  // built transition to wr, so it falls back to a cut rather than keeping
  // a transition edgeId that no longer makes sense.
  const result = removeQueueItem(queue, 1, 'hd', visible);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'cb');
  assert.deepEqual(result[1], { id: 'wr', mode: 'cut', ending: 'cut', starting: 'cut' });

  // removing the first hop re-derives it against Now Playing itself
  const result2 = removeQueueItem(queue, 0, 'hd', visible);
  assert.equal(result2[0].id, 'gs');
  assert.deepEqual(result2[0], { id: 'gs', mode: 'cut', ending: 'cut', starting: 'cut' }); // hd has no built transition to gs

  // removing the last hop leaves the rest untouched, nothing to recompute
  const result3 = removeQueueItem(queue, 2, 'hd', visible);
  assert.deepEqual(result3, queue.slice(0, 2));
});

test('removeSongCascade drops the song and every edge touching it, leaving the rest intact', () => {
  const songs = sampleSongsForTests();
  const edges = sampleEdgesForTests();
  const result = removeSongCascade(songs, edges, 'cb');
  assert.ok(!('cb' in result.songs));
  assert.ok(!result.edges.some(e => e.l === 'cb' || e.r === 'cb'));
  // hd's intro and gs's onward edges are untouched
  assert.ok(result.edges.some(e => e.id === 'e1'));
  assert.ok(result.edges.some(e => e.id === 'e13'));
});

test('libraryRows filters by search text and sorts by the requested key/direction', () => {
  const songs = sampleSongsForTests();
  const edges = sampleEdgesForTests();
  const byTitleAsc = libraryRows(songs, edges, '', 'title', 'asc');
  const titles = byTitleAsc.map(r => r.title);
  assert.deepEqual(titles, [...titles].sort());

  const byBpmDesc = libraryRows(songs, edges, '', 'bpm', 'desc');
  for (let i = 1; i < byBpmDesc.length; i++) assert.ok(byBpmDesc[i - 1].bpmNum >= byBpmDesc[i].bpmNum);

  const filtered = libraryRows(songs, edges, 'nomi', 'title', 'asc');
  assert.ok(filtered.every(r => r.artist.toLowerCase().includes('nomi')));
  assert.equal(filtered.length, 2); // Horizon Drift, Late Return

  const wr = libraryRows(songs, edges, '', 'title', 'asc').find(r => r.id === 'wr');
  assert.equal(wr.isDeadEnd, true); // Wire & Rust has no built outgoing edge at all
});

test('deterministic helpers are actually deterministic (same input -> same output every call)', () => {
  assert.equal(mockDuration('song-a'), mockDuration('song-a'));
  assert.ok(mockDuration('song-a') >= 150 && mockDuration('song-a') < 260);

  const cue1 = pseudoCuePoints('hd', 'cb');
  const cue2 = pseudoCuePoints('hd', 'cb');
  assert.deepEqual(cue1, cue2);

  const picksA = pickDetectedSongs(['hd', 'cb', 'gs'], 'file.wav|1234', 2);
  const picksB = pickDetectedSongs(['hd', 'cb', 'gs'], 'file.wav|1234', 2);
  assert.deepEqual(picksA, picksB);
  assert.equal(new Set(picksA).size, picksA.length); // never picks the same song twice

  assert.equal(hashString('same'), hashString('same'));
});

test('small formatters', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(fmtTime(65), '1:05');
  assert.equal(fmtTime(9), '0:09');
  assert.equal(fmtBytes(500), '500 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
});
