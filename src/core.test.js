// Pure-logic unit tests for core.js — no React, no browser APIs, just the
// data-model functions exercised against the sample graph the file itself
// ships for exactly this purpose (sampleSongsForTests/sampleEdgesForTests).
// Run with `npm test` (Node's built-in test runner, no extra dependency).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleSongsForTests, sampleEdgesForTests, emptySession, END,
  getVisibleEdges, inOutCounts, oneHopReachable, computeReachability,
  pickAutoplayNext, advanceSession, removeSongCascade, libraryRows,
  transitionTriggerElapsed, CROSSFADE_LOOKAHEAD_SEC,
  mockDuration, pseudoCuePoints, pickDetectedSongs, hashString,
  clamp, fmtTime, fmtBytes,
} from './core.js';

// Sample graph: hd -[transition]-> cb -[transition]-> gs -[transition]-> lr (unverified)
//                                    cb -[outro]     gs -[transition]-> wr
//                                                    gs -[outro]
//                intro -> hd

test('getVisibleEdges only keeps verified edges', () => {
  const edges = sampleEdgesForTests();
  const visible = getVisibleEdges(edges);
  assert.equal(visible.length, edges.length - 1); // e6 (gs->lr) is unverified
  assert.ok(!visible.some(e => e.id === 'e6'));
});

test('inOutCounts counts only verified, direction-appropriate edges', () => {
  const edges = sampleEdgesForTests();
  const gs = inOutCounts(edges, 'gs');
  // in: cb->gs (verified transition). out: gs->lr excluded (unverified), gs->wr
  // (verified transition) + gs's outro both count — outCount only excludes intro type.
  assert.equal(gs.inCount, 1);
  assert.equal(gs.outCount, 2);
});

test('oneHopReachable follows only built transitions, honoring the exclude set', () => {
  const visible = getVisibleEdges(sampleEdgesForTests());
  const fromCb = oneHopReachable(visible, 'cb', new Set());
  assert.deepEqual([...fromCb], ['gs']);
  const excluded = oneHopReachable(visible, 'cb', new Set(['gs']));
  assert.equal(excluded.size, 0);
});

test('computeReachability tier1 follows the queue tail, not always Now Playing', () => {
  const songs = sampleSongsForTests();
  const visible = getVisibleEdges(sampleEdgesForTests());
  const fresh = computeReachability(songs, visible, 'hd', []);
  assert.equal(fresh.fromId, 'hd');
  assert.ok(fresh.tier1.has('cb'));
  assert.ok(fresh.tier1.has(END)); // End Set is always offered once started

  const withQueue = computeReachability(songs, visible, 'hd', [{ id: 'cb', mode: 'transition' }]);
  assert.equal(withQueue.fromId, 'cb'); // reachability now radiates from the queue's tail
  assert.ok(withQueue.tier1.has('gs'));
  assert.ok(!withQueue.tier1.has('hd')); // never loops back onto Now Playing
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

test('advanceSession promotes the queue head and resets the ending choice', () => {
  const songs = sampleSongsForTests();
  const session = { ...emptySession(), nowPlayingId: 'hd', queue: [{ id: 'cb', mode: 'transition' }], timeLeft: 0, isPlaying: true };
  const next = advanceSession(session, songs, getVisibleEdges(sampleEdgesForTests()));
  assert.equal(next.nowPlayingId, 'cb');
  assert.equal(next.queue.length, 0);
  assert.equal(next.timeLeft, songs.cb.durationSec);
  assert.equal(next.endingChoice, 'cut');
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
  assert.equal(wr.isDeadEnd, true); // Wire & Rust has no built outgoing transition
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
