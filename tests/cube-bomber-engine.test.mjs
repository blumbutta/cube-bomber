import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZE, BOMB_STEP_SECONDS, FACE_COLLAPSE_INTERVAL, FACE_COLLAPSE_WARNING, FACE_SHRINK_INTERVAL, FACE_SHRINK_WARNING, FACES, Game, neighbor, tileKey, worldPoint, movementProgress, flameVulnerableCells, bombFlameCells, bombExplosionCell } from '../src/cube-bomber/engine.js';

const key = cell => tileKey(cell.face, cell.x, cell.y);
function emptyGame(options = {}) {
  const game = new Game({ seed: 412, bots: false, ...options });
  game.grid = FACES.map(() => Array.from({ length: SIZE }, () => Array(SIZE).fill(0)));
  game.players.forEach(player => player.protectedUntil = 0);
  game.events.length = 0;
  return game;
}
function bomb(game, face, x, y, range = 3, fuse = 2.7, owner = 0) {
  const value = { id: game.nextBombId++, face, x, y, range, fuse, owner };
  game.bombs.push(value);
  return value;
}
function position(actor, face, x, y) { Object.assign(actor, { face, x, y, previous: { face, x, y }, movedAt: 0, moveCooldown: 0, stepDuration: 0 }); }
const inverseSmooth = progress => 0.5 - Math.sin(Math.asin(1 - 2 * progress) / 3);
const adjacentFaces = (a, b) => FACES[a].n.reduce((sum, value, i) => sum + value * FACES[b].n[i], 0) === 0;

function finalArena(options = {}) {
  const game = emptyGame(options);
  game.players.forEach(actor => position(actor, 0, 3, 3));
  for (let face = 1; face < 6; face++) game.collapseFace(face);
  game.events.length = 0;
  return game;
}

test('the final face shrinks after30seconds to7×7, then after30more to centered6×6 permanently', () => {
  const game = finalArena();
  assert.equal(FACE_SHRINK_INTERVAL, 30);
  assert.equal(FACE_SHRINK_WARNING, 10);
  assert.deepEqual(game.nextShrink, { face: 0, at: 30, stage: 1, bounds: { minX: 0, maxX: 6, minY: 0, maxY: 6 } });
  game.update(19.999);
  assert.equal(game.events.filter(event => event.type === 'shrink-warning').length, 0);
  game.update(0.001);
  const firstWarning = game.events.find(event => event.type === 'shrink-warning');
  assert.equal(firstWarning.cells.length, 15);
  assert.ok(firstWarning.cells.every(cell => cell.x === 7 || cell.y === 7));
  assert.ok(Math.abs(game.dangerMap().get('0:7:3') - 10) < 1e-8);
  assert.equal(game.dangerMap().has('0:3:3'), false);
  game.update(9.999);
  assert.equal(game.faceBounds[0].maxX, 7);
  game.update(0.001);
  assert.deepEqual(game.faceBounds[0], { minX: 0, maxX: 6, minY: 0, maxY: 6 });
  assert.equal(game.shrinkHistory[0].cells.length, 15);
  assert.ok(Math.abs(game.shrinkHistory[0].at - 30) < 1e-8);
  assert.ok(Math.abs(game.nextShrink.at - 60) < 1e-8);
  assert.equal(game.nextShrink.stage, 2);
  game.update(20);
  const warnings = game.events.filter(event => event.type === 'shrink-warning');
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].cells.length, 13);
  assert.ok(warnings[1].cells.every(cell => cell.x === 0 || cell.y === 0));
  assert.ok(Math.abs(game.dangerMap().get('0:0:3') - 10) < 1e-8);
  assert.equal(game.dangerMap().has('0:6:3'), false);
  game.update(10);
  assert.deepEqual(game.faceBounds[0], { minX: 1, maxX: 6, minY: 1, maxY: 6 });
  assert.equal(game.nextShrink, null);
  assert.equal(game.shrinkHistory.length, 2);
  const liveCells = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (game.isCellActive({ face: 0, x, y })) liveCells.push({ x, y });
  assert.equal(liveCells.length, 36);
  game.update(300);
  assert.equal(game.shrinkHistory.length, 2);
  assert.equal(game.events.filter(event => event.type === 'shrink').length, 2);
  game.reset();
  assert.equal(game.nextShrink, null);
  assert.deepEqual(game.shrinkHistory, []);
  assert.ok(game.faceBounds.every(bounds => bounds.minX === 0 && bounds.maxX === 7 && bounds.minY === 0 && bounds.maxY === 7));
});

test('both shrinking boundaries apply20% entry and80% exit grace to each removed row and column', () => {
  const boundsByStage = [{ minX: 0, maxX: 6, minY: 0, maxY: 6 }, { minX: 1, maxX: 6, minY: 1, maxY: 6 }];
  for (const stage of [1, 2]) for (const axis of ['x', 'y']) for (const [entering, fraction, survives] of [[true, 0.2, true], [true, 0.2001, false], [false, 0.7999, false], [false, 0.8, true]]) {
    const game = finalArena();
    if (stage === 2) game.shrinkFace(0, boundsByStage[0], 1);
    const actor = game.players[0];
    const removed = stage === 1 ? 7 : 0;
    const safe = stage === 1 ? 6 : 1;
    const start = entering ? safe : removed;
    position(actor, 0, axis === 'x' ? start : 3, axis === 'y' ? start : 3);
    const positive = entering === (stage === 1);
    const dir = axis === 'x' ? (positive ? 1 : 3) : (positive ? 2 : 0);
    game.move(0, dir);
    game.time = actor.movedAt + inverseSmooth(fraction) * actor.stepDuration;
    game.shrinkFace(0, boundsByStage[stage - 1], stage);
    assert.equal(actor.alive, survives);
    if (survives) assert.equal(game.isCellActive(actor), true);
    else {
      const event = game.events.find(event => event.type === 'death' && event.id === 0);
      assert.equal(event.cause, 'shrink');
      assert.equal(event[axis], removed);
    }
  }
});

test('removed shrink cells block actors, kicks, flames and paths and remove their contents', () => {
  const game = finalArena();
  const removed = bomb(game, 0, 7, 3, 1, 9, 1);
  const kept = bomb(game, 0, 6, 5, 3, 9, 2);
  game.bonuses.push({ face: 0, x: 7, y: 2, type: 'range' }, { face: 0, x: 5, y: 2, type: 'bomb' });
  game.flames.push({ face: 0, x: 7, y: 1, ttl: 1 });
  game.shrinkFace(0, game.nextShrink.bounds, 1);
  assert.deepEqual(game.bombs, [kept]);
  assert.equal(game.bonuses.length, 1);
  assert.equal(game.flames.length, 0);
  assert.deepEqual(game.blastCells(removed), []);
  assert.ok(game.blastCells(kept).every(cell => game.isCellActive(cell)));
  position(game.players[0], 0, 6, 3);
  assert.equal(game.move(0, 1), false);
  assert.equal(game.findPath(game.players[0], new Map(), cell => cell.x === 7), null);
  position(game.players[0], 0, 5, 3);
  const edgeBomb = bomb(game, 0, 6, 3, 1, 9, 0);
  assert.equal(game.move(0, 1), false);
  assert.equal(edgeBomb.x, 6);
  position(game.players[1], 0, 7, 4);
  assert.equal(game.placeBomb(1), false);
});

test('a shrink warning sends a bot away from the doomed outer strip', () => {
  const game = finalArena({ bots: true });
  game.players.forEach(actor => { actor.botThink = 1000; actor.protectedUntil = 1000; });
  position(game.players[1], 0, 7, 3);
  game.players[1].botThink = 0;
  game.nextShrink.at = 10;
  game.update(1);
  assert.ok(game.players[1].x <= 6 && game.players[1].y <= 6);
  assert.ok(game.events.some(event => event.type === 'move' && event.id === 1 && event.from.x === 7 && event.to.x === 6));
});

test('six human-controlled slots never run bot AI', () => {
  const game = emptyGame({ bots: true, multiplayer: true, humanIds: [0, 1, 2, 3, 4, 5] });
  game.update(5);
  assert.ok(!game.events.some(event => event.type === 'move' || event.type === 'bomb'));
  assert.ok(game.players.every(actor => actor.face === actor.id && actor.x === 3 && actor.y === 3));
});

test('multiplayer continues after player0 dies and another human can still play', () => {
  const game = emptyGame({ bots: true, multiplayer: true, humanIds: [0, 2] });
  game.players.forEach(actor => actor.botThink = 1000);
  game.players[2].protectedUntil = 100;
  game.flames.push({ face: 0, x: 3, y: 3, ttl: 1 });
  game.update(0.05);
  assert.equal(game.players[0].alive, false);
  assert.equal(game.status, 'playing');
  assert.equal(game.endedAt, null);
  assert.equal(game.move(2, 1), true);
  assert.equal(game.placeBomb(2), true);
  game.update(4);
  assert.equal(game.isRunning(), true);
  assert.equal(game.move(2, 2), true);
});

test('human slot changes immediately enable or disable its bot, including slot0', () => {
  const game = emptyGame({ bots: true, multiplayer: true, humanIds: [1, 2, 3, 4, 5] });
  game.players[0].botThink = 0;
  game.update(0.05);
  assert.ok(game.events.some(event => event.type === 'move' && event.id === 0));
  game.humanIds = new Set([0, 1, 2, 3, 4, 5]);
  game.events.length = 0;
  game.players[0].botThink = 0;
  game.players[0].moveCooldown = 0;
  game.update(1);
  assert.ok(!game.events.some(event => event.type === 'move' || event.type === 'bomb'));
});

test('multiplayer records any surviving winner or a simultaneous draw, then freezes gameplay', () => {
  for (const winner of [3, null]) {
    const game = emptyGame({ multiplayer: true, humanIds: [0, 1, 2, 3, 4, 5] });
    const pending = bomb(game, 3, 0, 0, 1, 9, 3);
    game.flames = game.players.filter(actor => actor.id !== winner).map(actor => ({ face: actor.face, x: actor.x, y: actor.y, ttl: 1 }));
    game.update(0.05);
    assert.equal(game.status, 'finished');
    assert.equal(game.winnerId, winner);
    assert.equal(game.endedAt, 0.05);
    assert.equal(game.isRunning(), false);
    if (winner !== null) assert.equal(game.players[winner].place, 1);
    else assert.ok(game.players.every(actor => actor.place === 6));
    const fuse = pending.fuse;
    game.update(3);
    assert.equal(pending.fuse, fuse);
    assert.equal(game.move(3, 1), false);
    assert.equal(game.placeBomb(3), false);
    assert.equal(game.events.filter(event => event.type === 'end').length, 1);
    game.reset();
    assert.equal(game.status, 'playing');
    assert.equal(game.winnerId, null);
    assert.equal(game.endedAt, null);
    assert.equal(game.humanIds.size, 6);
  }
});

test('collapse warns exactly10seconds before60, happens once, and clears the danger warning', () => {
  const game = emptyGame();
  assert.equal(FACE_COLLAPSE_INTERVAL, 60);
  assert.equal(FACE_COLLAPSE_WARNING, 10);
  assert.equal(game.nextCollapse.at, 60);
  const target = game.nextCollapse.face;
  const safe = FACES.find(face => face.id !== target).id;
  game.players.forEach(actor => position(actor, safe, 3, 3));
  game.update(49.999);
  assert.equal(game.events.filter(event => event.type === 'collapse-warning').length, 0);
  assert.equal(game.dangerMap().size, 0);
  game.update(0.001);
  assert.deepEqual(game.events.find(event => event.type === 'collapse-warning'), { type: 'collapse-warning', face: target, at: 60 });
  assert.ok(Math.abs(game.dangerMap().get(tileKey(target, 3, 3)) - 10) < 1e-8);
  game.update(9.999);
  assert.equal(game.collapsedFaces.size, 0);
  game.update(0.001);
  assert.equal(game.isFaceActive(target), false);
  assert.ok(Math.abs(game.faceCollapses.get(target) - 60) < 1e-8);
  assert.ok(Math.abs(game.nextCollapse.at - 120) < 1e-8);
  assert.equal(game.dangerMap().size, 0);
  game.update(0.1);
  assert.equal(game.events.filter(event => event.type === 'collapse-warning').length, 1);
  assert.equal(game.events.filter(event => event.type === 'collapse').length, 1);
});

test('collapse starts randomly, proceeds to adjacent faces, preserves connectivity, and leaves one face', () => {
  const firstFaces = new Set();
  for (let seed = 0; seed < 48; seed++) {
    const game = emptyGame({ seed });
    firstFaces.add(game.nextCollapse.face);
    let lastFace = null;
    for (let round = 1; round <= 5; round++) {
      const { face, at } = game.nextCollapse;
      if (lastFace !== null) assert.ok(adjacentFaces(lastFace, face));
      assert.equal(at, round * FACE_COLLAPSE_INTERVAL);
      const safe = FACES.find(candidate => game.isFaceActive(candidate.id) && candidate.id !== face).id;
      game.players.forEach(actor => position(actor, safe, 3, 3));
      game.time = at;
      assert.equal(game.collapseFace(face), true);
      assert.equal(game.collapsedFaces.size, round);
      const remaining = FACES.filter(candidate => game.isFaceActive(candidate.id)).map(candidate => candidate.id);
      const reached = new Set([remaining[0]]);
      const queue = [remaining[0]];
      for (let i = 0; i < queue.length; i++) for (const next of remaining) {
        if (!reached.has(next) && adjacentFaces(queue[i], next)) { reached.add(next); queue.push(next); }
      }
      assert.equal(reached.size, remaining.length);
      lastFace = face;
    }
    assert.equal(game.nextCollapse, null);
    const final = FACES.find(face => game.isFaceActive(face.id)).id;
    assert.equal(game.collapseFace(final), false);
    assert.equal(game.events.filter(event => event.type === 'collapse').length, 5);
    game.reset(seed);
    assert.equal(game.collapsedFaces.size, 0);
    assert.equal(game.faceCollapses.size, 0);
    assert.equal(game.nextCollapse.at, FACE_COLLAPSE_INTERVAL);
    assert.ok(FACES.every(face => game.isFaceActive(face.id)));
  }
  assert.equal(firstFaces.size, 6);
});

test('collapse removes its content and kills one simultaneous batch, even during spawn protection', () => {
  const game = emptyGame();
  game.players.forEach(actor => position(actor, 1, 3, 3));
  position(game.players[1], 0, 3, 3);
  position(game.players[2], 0, 4, 3);
  game.players[1].protectedUntil = 1000;
  game.players[2].protectedUntil = 1000;
  game.grid[0][2][3] = 2;
  const removed = bomb(game, 0, 3, 3, 1, 9, 1);
  const kept = bomb(game, 1, 0, 0, 1, 9, 3);
  game.bonuses.push({ face: 0, x: 2, y: 2, type: 'range' }, { face: 1, x: 2, y: 2, type: 'bomb' });
  game.flames.push({ face: 0, x: 1, y: 1, ttl: 1 }, { face: 1, x: 1, y: 1, ttl: 1 });
  game.time = 120;
  game.collapseFace(0);
  assert.equal(game.players[1].alive, false);
  assert.equal(game.players[2].alive, false);
  assert.equal(game.players[1].place, 6);
  assert.equal(game.players[2].place, 6);
  assert.ok(game.events.filter(event => event.type === 'death').every(event => event.cause === 'collapse' && event.face === 0));
  assert.ok(game.grid[0].flat().every(tile => tile === 0));
  assert.deepEqual(game.bombs, [kept]);
  assert.ok(!game.bonuses.some(bonus => bonus.face === 0));
  assert.ok(!game.flames.some(flame => flame.face === 0));
  assert.equal(game.canEnter({ face: 0, x: 3, y: 3 }), false);
  assert.deepEqual(game.blastCells(removed), []);
});

test('collapse uses the same20%entry and80%exit grace and reports the falling face in death events', () => {
  for (const [collapsing, fraction, survives] of [['source', 0.7999, false], ['source', 0.8, true], ['destination', 0.2, true], ['destination', 0.2001, false]]) {
    const game = emptyGame();
    const actor = game.players[0];
    position(actor, 0, 7, 2);
    game.move(0, 1);
    game.time = inverseSmooth(fraction) * actor.stepDuration;
    const target = collapsing === 'source' ? 0 : actor.face;
    game.collapseFace(target);
    assert.equal(actor.alive, survives);
    if (!survives) {
      const death = game.events.find(event => event.type === 'death' && event.id === 0);
      assert.equal(death.face, target);
      assert.equal(death.cause, 'collapse');
    } else {
      assert.equal(game.isFaceActive(actor.face), true);
      if (collapsing === 'destination') {
        assert.equal(actor.face, 0);
        assert.equal(actor.stepDuration, 0);
        assert.equal(actor.moveCooldown, 0);
        assert.equal(actor.dir, 1);
        assert.ok(game.events.some(event => event.type === 'collapse-return' && event.id === 0));
      }
    }
  }
});

test('collapse warning makes bots leave a clear face even without any bomb danger', () => {
  const game = emptyGame({ bots: true });
  game.players.forEach(actor => { actor.protectedUntil = 1000; actor.botThink = 1000; });
  const actor = game.players[1];
  actor.botThink = 0;
  game.nextCollapse = { face: actor.face, at: 10 };
  assert.equal(game.bombs.length, 0);
  game.update(2);
  assert.notEqual(actor.face, 1);
  assert.equal(actor.alive, true);
  assert.ok(game.events.some(event => event.type === 'move' && event.id === actor.id && event.from.face !== event.to.face));
});

test('a warned bot trapped by bricks plants a breakout bomb and takes temporary cover', () => {
  const game = new Game({ seed: 8312, bots: true });
  game.players.forEach(actor => { actor.protectedUntil = 0; actor.botThink = 1000; });
  game.players[1].botThink = 0;
  game.nextCollapse = { face: 1, at: 10 };
  game.update(3.2);
  assert.ok(game.events.some(event => event.type === 'bomb' && event.owner === 1));
  assert.ok(game.events.some(event => event.type === 'brick' && event.face === 1));
  assert.equal(game.players[1].alive, true);
});

test('rolling bomb contact follows visible20%/80% thresholds and detonation centers switch at50%', () => {
  const source = { face: 0, x: 3, y: 3 };
  const destination = { face: 0, x: 4, y: 3 };
  const rolling = { ...destination, previous: source, movedAt: 10, moving: true };
  for (const [fraction, expected] of [[0, [source]], [0.2, [source]], [0.2001, [source, destination]], [0.5, [source, destination]], [0.7999, [source, destination]], [0.8, [destination]], [1, [destination]]]) {
    const time = rolling.movedAt + inverseSmooth(fraction) * BOMB_STEP_SECONDS;
    assert.deepEqual(bombFlameCells(rolling, time), expected);
    assert.deepEqual(bombExplosionCell(rolling, time), fraction < 0.5 ? source : destination);
  }
  assert.deepEqual(bombExplosionCell(rolling, rolling.movedAt + inverseSmooth(0.4999) * BOMB_STEP_SECONDS), source);
  assert.deepEqual(bombExplosionCell(rolling, rolling.movedAt + inverseSmooth(0.5001) * BOMB_STEP_SECONDS), destination);
  assert.deepEqual(bombFlameCells(destination, 10), [destination]);
  assert.deepEqual(bombExplosionCell(destination, 10), destination);
});

test('stationary bombs chain across every pair of owners and return each owner capacity', () => {
  for (let firstOwner = 0; firstOwner < 6; firstOwner++) for (let secondOwner = 0; secondOwner < 6; secondOwner++) {
    const game = emptyGame();
    bomb(game, 0, 4, 2, 1, 0.05, firstOwner);
    bomb(game, 0, 4, 3, 1, 8, secondOwner);
    game.update(0.05);
    assert.equal(game.bombs.length, 0);
    assert.deepEqual(game.events.filter(event => event.type === 'explode').map(event => event.owner), [firstOwner, secondOwner]);
  }
});

test('rays stop at a moving bomb visible footprint instead of passing through its trailing body', () => {
  const game = emptyGame();
  const trigger = bomb(game, 0, 3, 3, 5, 0.2, 0);
  const moving = bomb(game, 0, 6, 4, 1, 9, 1);
  Object.assign(moving, { previous: { face: 0, x: 6, y: 3 }, movedAt: 0, moving: true });
  game.time = inverseSmooth(0.1) * BOMB_STEP_SECONDS;
  const cells = new Set(game.blastCells(trigger).map(key));
  assert.ok(cells.has('0:6:3'));
  assert.ok(!cells.has('0:7:3'));
  game.explode(trigger);
  assert.equal(game.bombs.length, 0);
  const secondary = game.events.find(event => event.type === 'explode' && event.id === moving.id);
  assert.deepEqual([secondary.face, secondary.x, secondary.y], [0, 6, 3]);
});

test('danger propagation tracks every rolling bomb that overlaps the same physical cell', () => {
  const game = emptyGame();
  game.time = 1;
  bomb(game, 0, 5, 1, 2, 0.1, 0);
  const first = bomb(game, 0, 5, 3, 1, 8, 1);
  Object.assign(first, { previous: { face: 0, x: 4, y: 3 }, movedAt: game.time - inverseSmooth(0.4) * BOMB_STEP_SECONDS });
  const second = bomb(game, 0, 5, 4, 1, 9, 2);
  Object.assign(second, { previous: { face: 0, x: 5, y: 3 }, movedAt: game.time - inverseSmooth(0.6) * BOMB_STEP_SECONDS });
  assert.ok(bombFlameCells(first, game.time).some(cell => key(cell) === '0:5:3'));
  assert.ok(bombFlameCells(second, game.time).some(cell => key(cell) === '0:5:3'));
  assert.equal(game.dangerMap().get('0:3:3'), 0.1);
  assert.equal(game.dangerMap().get('0:6:4'), 0.1);
});

test('placing a bomb in existing fire ignites it regardless of its owner', () => {
  for (let owner = 0; owner < 6; owner++) {
    const game = emptyGame();
    const actor = game.players[owner];
    actor.protectedUntil = 100;
    game.flames.push({ face: actor.face, x: actor.x, y: actor.y, ttl: 1 });
    assert.equal(game.placeBomb(owner), true);
    assert.equal(game.dangerMap().get(tileKey(actor.face, actor.x + 1, actor.y)), 0);
    game.update(0.01);
    assert.equal(game.bombs.length, 0);
    assert.equal(game.events.filter(event => event.type === 'explode').length, 1);
  }
});

test('flame collision cells follow eased movement with inclusive20% entry and80% exit grace', () => {
  const source = { face: 0, x: 3, y: 3 };
  const destination = { face: 0, x: 4, y: 3 };
  const actor = { ...destination, previous: source, movedAt: 10, stepDuration: 0.3 };
  for (const [fraction, expected] of [[0, [source]], [0.2, [source]], [0.2001, [source, destination]], [0.5, [source, destination]], [0.7999, [source, destination]], [0.8, [destination]], [1, [destination]]]) {
    const time = actor.movedAt + inverseSmooth(fraction) * actor.stepDuration;
    assert.ok(Math.abs(movementProgress(actor, time) - fraction) < 1e-12);
    assert.deepEqual(flameVulnerableCells(actor, time), expected);
  }
  assert.equal(movementProgress(actor, 9), 0);
  assert.equal(movementProgress(actor, 11), 1);
  assert.deepEqual(flameVulnerableCells({ ...actor, previous: destination }, 10), [destination]);
  assert.deepEqual(flameVulnerableCells({ ...actor, stepDuration: 0 }, 10), [destination]);
  assert.deepEqual(flameVulnerableCells(destination, 10), [destination]);
});

test('entering fire is initially safe, but becomes lethal after20% of the visible step', () => {
  for (const actorId of [0, 1]) {
    const game = emptyGame();
    const actor = game.players[actorId];
    game.flames.push({ face: actor.face, x: actor.x + 1, y: actor.y, ttl: 1 });
    assert.equal(game.move(actorId, 1), true);
    assert.equal(actor.alive, true);
    game.time = actor.movedAt + inverseSmooth(0.2) * actor.stepDuration;
    game.checkFlameDeaths();
    assert.equal(actor.alive, true);
    game.time = actor.movedAt + inverseSmooth(0.2001) * actor.stepDuration;
    game.checkFlameDeaths();
    assert.equal(actor.alive, false);
  }
});

test('source fire can kill during a step but no longer reaches an actor from80% onward', () => {
  for (const [fraction, survives] of [[0.7999, false], [0.8, true], [0.99, true], [1, true]]) {
    const game = emptyGame();
    const actor = game.players[0];
    const source = { face: actor.face, x: actor.x, y: actor.y };
    game.move(0, 1);
    game.time = actor.movedAt + inverseSmooth(fraction) * actor.stepDuration;
    game.flames.push({ ...source, ttl: 1 });
    game.checkFlameDeaths();
    assert.equal(actor.alive, survives);
  }
  const game = emptyGame();
  const actor = game.players[0];
  game.move(0, 1);
  game.time = actor.movedAt + actor.stepDuration / 2;
  game.flames.push({ ...actor.previous, ttl: 1 }, { face: actor.face, x: actor.x, y: actor.y, ttl: 1 });
  game.checkFlameDeaths();
  assert.equal(actor.alive, false);
});

test('collecting a speed bonus does not retroactively accelerate the current visible step', () => {
  const game = emptyGame();
  const actor = game.players[0];
  game.bonuses.push({ face: actor.face, x: actor.x + 1, y: actor.y, type: 'speed' });
  game.move(0, 1);
  assert.equal(actor.speed, 2);
  assert.equal(actor.stepDuration, 0.3);
  assert.equal(movementProgress(actor, actor.movedAt + 0.15), 0.5);
  game.update(0.3);
  assert.equal(game.move(0, 1), true);
  assert.equal(actor.stepDuration, 0.3 / 1.07);
});

test('all 1536 surface steps are reciprocal, in bounds, and physically continuous', () => {
  for (const face of FACES) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) for (let dir = 0; dir < 4; dir++) {
    const next = neighbor(face.id, x, y, dir);
    assert.ok(next.face >= 0 && next.face < 6 && next.x >= 0 && next.x < 8 && next.y >= 0 && next.y < 8);
    const back = neighbor(next.face, next.x, next.y, (next.dir + 2) % 4);
    assert.deepEqual(back, { face: face.id, x, y, dir: (dir + 2) % 4 });
    const a = worldPoint(face.id, x, y);
    const b = worldPoint(next.face, next.x, next.y);
    assert.equal(a.reduce((total, value, i) => total + Math.abs(value - b[i]), 0), 1);
    const bFace = FACES[next.face];
    assert.equal(b.reduce((total, value, i) => total + value * bFace.n[i], 0), 4);
  }
});

test('straight lines loop around four faces and return to the same orientation', () => {
  for (const face of FACES) for (let x = 0; x < 8; x++) for (let dir = 0; dir < 4; dir++) {
    let cell = { face: face.id, x, y: 3, dir };
    for (let step = 0; step < SIZE * 4; step++) cell = neighbor(cell.face, cell.x, cell.y, cell.dir);
    assert.deepEqual(cell, { face: face.id, x, y: 3, dir });
  }
});

test('dense seeded maps start each actor in a safe 2×2 room enclosed by destructible bricks', () => {
  const game = new Game({ seed: 719, bots: false });
  const again = new Game({ seed: 719, bots: false });
  assert.deepEqual(game.grid, again.grid);
  assert.notDeepEqual(game.grid[0], game.grid[1]);
  assert.equal(game.players.length, 6);
  game.players.forEach(player => {
    assert.equal(player.face, player.id);
    assert.deepEqual([player.x, player.y], [3, 3]);
    assert.equal(player.range, 1);
    for (const y of [3, 4]) for (const x of [3, 4]) assert.equal(game.grid[player.face][y][x], 0);
    for (let i = 0; i < 8; i++) for (const [x, y] of [[0, i], [7, i], [i, 0], [i, 7]]) assert.notEqual(game.grid[player.face][y][x], 1);
    const spawnQueue = [{ face: player.face, x: 3, y: 3 }];
    const spawnSeen = new Set(spawnQueue.map(key));
    for (let i = 0; i < spawnQueue.length; i++) for (let dir = 0; dir < 4; dir++) {
      const next = neighbor(spawnQueue[i].face, spawnQueue[i].x, spawnQueue[i].y, dir);
      if (!spawnSeen.has(key(next)) && game.canEnter(next)) { spawnSeen.add(key(next)); spawnQueue.push(next); }
    }
    assert.equal(spawnSeen.size, 4);
    const preview = game.blastCells({ id: -1, ...player });
    assert.ok(preview.some(cell => game.grid[cell.face][cell.y][cell.x] === 2));
    assert.ok(!preview.some(cell => cell.face === player.face && cell.x === 4 && cell.y === 4));
    assert.equal(game.canEscapeBomb(player), true);
  });
  assert.ok(game.grid.flat(2).filter(tile => tile === 2).length > 6 * 30);
  game.grid = game.grid.map(face => face.map(row => row.map(tile => tile === 2 ? 0 : tile)));
  const queue = [{ face: 0, x: 3, y: 3 }];
  const seen = new Set(queue.map(key));
  for (let i = 0; i < queue.length; i++) for (let dir = 0; dir < 4; dir++) {
    const next = neighbor(queue[i].face, queue[i].x, queue[i].y, dir);
    if (!seen.has(key(next)) && game.canEnter(next)) { seen.add(key(next)); queue.push(next); }
  }
  assert.ok(game.players.every(player => seen.has(key(player))));
  assert.equal(seen.size, game.grid.flat(2).filter(tile => tile === 0).length);
});

test('flame range is conserved through edges and walls / bricks stop each ray', () => {
  const game = emptyGame();
  const origin = bomb(game, 0, 6, 3, 4);
  let cell = { ...origin, dir: 1 };
  const ray = [];
  for (let i = 0; i < 5; i++) { cell = neighbor(cell.face, cell.x, cell.y, cell.dir); ray.push(cell); }
  let blast = new Set(game.blastCells(origin).map(key));
  ray.slice(0, 4).forEach(cell => assert.ok(blast.has(key(cell))));
  assert.ok(!blast.has(key(ray[4])));
  assert.notEqual(ray[1].face, origin.face);
  const brick = ray[1];
  game.grid[brick.face][brick.y][brick.x] = 2;
  blast = new Set(game.blastCells(origin).map(key));
  assert.ok(blast.has(key(brick)));
  assert.ok(!blast.has(key(ray[2])));
  game.grid[brick.face][brick.y][brick.x] = 1;
  blast = new Set(game.blastCells(origin).map(key));
  assert.ok(!blast.has(key(brick)));
});

test('chain reactions cross edges, advance danger times, and burn remote actors', () => {
  const game = emptyGame();
  bomb(game, 0, 7, 3, 3, 0.1);
  const nearEdge = neighbor(0, 7, 3, 1);
  const target = neighbor(nearEdge.face, nearEdge.x, nearEdge.y, nearEdge.dir);
  bomb(game, target.face, target.x, target.y, 1, 9, 2);
  const victim = neighbor(target.face, target.x, target.y, target.dir);
  position(game.players[2], victim.face, victim.x, victim.y);
  assert.ok(Math.abs(game.dangerMap().get(key(victim)) - 0.1) < 1e-8);
  game.update(0.1);
  assert.equal(game.bombs.length, 0);
  assert.equal(game.players[2].alive, false);
  assert.equal(game.events.filter(event => event.type === 'explode').length, 2);
});

test('movement respects obstacles and cooldown; crossing an edge reserves the camera transition', () => {
  const game = emptyGame();
  game.grid[0][3][4] = 1;
  assert.equal(game.move(0, 1), false);
  game.grid[0][3][4] = 2;
  assert.equal(game.move(0, 1), false);
  game.grid[0][3][4] = 0;
  assert.equal(game.move(0, 1), true);
  assert.equal(game.move(0, 1), false);
  game.update(0.18);
  assert.equal(game.move(0, 1), false);
  game.update(0.12);
  assert.equal(game.move(0, 1), true);
  position(game.players[0], 0, 7, 2);
  assert.equal(game.move(0, 1), true);
  assert.equal(game.players[0].face, 2);
  assert.equal(game.players[0].moveCooldown, 0.5);
  assert.deepEqual(game.players[0].previous, { face: 0, x: 7, y: 2 });
});

test('bomb capacity is enforced and the owner can leave a freshly placed bomb', () => {
  const game = emptyGame();
  assert.equal(game.placeBomb(0), true);
  assert.equal(game.placeBomb(0), false);
  assert.equal(game.move(0, 3), true);
  assert.equal(game.placeBomb(0), false);
  game.players[0].capacity = 2;
  assert.equal(game.placeBomb(0), true);
});

test('returning to an own bomb kicks it, keeps its fuse, and slides three tiles per second', () => {
  const game = emptyGame();
  game.placeBomb(0);
  game.move(0, 3);
  game.update(0.3);
  const fuse = game.bombs[0].fuse;
  assert.equal(game.move(0, 1), true);
  const kicked = game.bombs[0];
  assert.deepEqual([game.players[0].x, kicked.x], [3, 4]);
  assert.equal(kicked.fuse, fuse);
  assert.equal(kicked.moving, true);
  assert.deepEqual(kicked.previous, { face: 0, x: 3, y: 3 });
  assert.equal(game.events.filter(event => event.type === 'kick').length, 1);
  game.update(0.2);
  assert.equal(kicked.x, 4);
  game.update(0.8);
  assert.equal(kicked.x, 7);
  assert.ok(Math.abs(kicked.fuse - (fuse - 1)) < 1e-8);
});

test('only owned bombs can be kicked; walls, bricks, bombs, and actors block kicks', () => {
  for (const blocker of ['wall', 'brick', 'bomb', 'actor', 'foreign']) {
    const game = emptyGame();
    position(game.players[0], 0, 2, 3);
    const placed = bomb(game, 0, 3, 3, 3, 2.7, blocker === 'foreign' ? 1 : 0);
    if (blocker === 'wall') game.grid[0][3][4] = 1;
    if (blocker === 'brick') game.grid[0][3][4] = 2;
    if (blocker === 'bomb') bomb(game, 0, 4, 3);
    if (blocker === 'actor') position(game.players[1], 0, 4, 3);
    assert.equal(game.move(0, 1), false, blocker);
    assert.equal(placed.x, 3, blocker);
    assert.equal(game.players[0].x, 2, blocker);
  }
});

test('sliding bombs rotate on edges and stop before obstacles', () => {
  const game = emptyGame();
  position(game.players[0], 0, 6, 2);
  const placed = bomb(game, 0, 7, 2);
  const across = neighbor(0, 7, 2, 1);
  assert.equal(game.move(0, 1), true);
  assert.deepEqual([placed.face, placed.x, placed.y, placed.dir], [across.face, across.x, across.y, across.dir]);
  const next = neighbor(placed.face, placed.x, placed.y, placed.dir);
  game.grid[next.face][next.y][next.x] = 2;
  game.update(BOMB_STEP_SECONDS);
  assert.equal(placed.moving, false);
  assert.equal(key(placed), key(across));
  assert.ok(Math.abs(placed.fuse - (2.7 - BOMB_STEP_SECONDS)) < 1e-8);
});

test('a kicked bomb ignites when its visible body reaches existing fire without waiting for its fuse', () => {
  const game = emptyGame();
  position(game.players[0], 0, 2, 3);
  bomb(game, 0, 3, 3, 1, 2.7);
  game.flames.push({ face: 0, x: 4, y: 3, ttl: 0.75 });
  assert.equal(game.move(0, 1), true);
  assert.equal(game.dangerMap().get('0:3:2'), 2.7);
  game.update(0.05);
  assert.equal(game.bombs.length, 1);
  game.time = 0.1;
  assert.equal(game.dangerMap().get('0:3:2'), 0);
  game.update(0.01);
  assert.equal(game.bombs.length, 0);
  assert.ok(game.events.some(event => event.type === 'explode'));
});

test('bonuses improve range, simultaneous capacity, and effective speed with caps', () => {
  const game = emptyGame();
  const actor = game.players[0];
  for (const [type, property, cap] of [['range', 'range', 12], ['bomb', 'capacity', 5], ['speed', 'speed', 4]]) {
    const before = actor[property];
    game.bonuses.push({ face: actor.face, x: actor.x, y: actor.y, type });
    game.collectBonus(actor);
    assert.equal(actor[property], before + 1);
    actor[property] = cap;
    game.bonuses.push({ face: actor.face, x: actor.x, y: actor.y, type });
    game.collectBonus(actor);
    assert.equal(actor[property], cap);
  }
  assert.ok(game.moveDuration(actor) < 0.3);
  assert.equal(game.moveDuration(actor), 0.3 / (1 + 3 * 0.07));
  assert.equal(game.events.filter(event => event.type === 'bonus').length, 6);
});

test('all characters have the same base speed, upgrades, and edge-crossing cooldown', () => {
  const game = emptyGame();
  const human = game.players[0];
  const bot = game.players[1];
  assert.equal(game.moveDuration(human), 0.3);
  assert.equal(game.moveDuration(bot), 0.3);
  assert.equal(BOMB_STEP_SECONDS, 1 / 3);
  human.speed = 2;
  bot.speed = 2;
  assert.equal(game.moveDuration(human), 0.3 / 1.07);
  assert.equal(game.moveDuration(bot), 0.3 / 1.07);
  position(human, 0, 7, 2);
  position(bot, 1, 7, 2);
  assert.equal(game.move(human.id, 1), true);
  assert.equal(game.move(bot.id, 1), true);
  assert.equal(human.moveCooldown, 0.5);
  assert.equal(bot.moveCooldown, 0.5);
});

test('bonus drops favor capacity65%, then speed20%, then range15%, at an overall45% rate', () => {
  for (const [roll, expected] of [[0, 'bomb'], [0.649999, 'bomb'], [0.65, 'speed'], [0.849999, 'speed'], [0.85, 'range'], [0.999999, 'range']]) {
    const game = emptyGame();
    game.grid[0][3][4] = 2;
    const sequence = [0.449999, roll];
    game.random = () => sequence.shift() ?? 0.99;
    game.explode(bomb(game, 0, 3, 3, 1));
    assert.equal(game.bonuses.length, 1);
    assert.equal(game.bonuses[0].type, expected);
  }
  const game = emptyGame();
  game.grid[0][3][4] = 2;
  game.random = () => 0.45;
  game.explode(bomb(game, 0, 3, 3, 1));
  assert.equal(game.bonuses.length, 0);
});

test('bots decline a bomb when the escape corridor is too long at their current speed', () => {
  const game = emptyGame();
  game.grid = FACES.map(() => Array.from({ length: SIZE }, () => Array(SIZE).fill(1)));
  const actor = game.players[1];
  position(actor, 0, 3, 3);
  actor.range = 7;
  let cell = { face: 0, x: 3, y: 3, dir: 1 };
  for (let step = 0; step <= 8; step++) {
    game.grid[cell.face][cell.y][cell.x] = 0;
    cell = neighbor(cell.face, cell.x, cell.y, cell.dir);
  }
  assert.equal(game.canEscapeBomb(actor), false);
  actor.speed = 4;
  assert.equal(game.canEscapeBomb(actor), true);
  assert.equal(game.bombs.length, 0);
});

test('bot path timing includes remaining cooldown and the full edge-crossing duration', () => {
  const game = emptyGame();
  const actor = game.players[1];
  position(actor, 0, 7, 2);
  actor.moveCooldown = 0.1;
  const across = neighbor(actor.face, actor.x, actor.y, 1);
  const route = game.findPath(actor, new Map(), cell => key(cell) === key(across));
  assert.equal(route.firstDir, 1);
  assert.ok(Math.abs(route.elapsed - 0.6) < 1e-8);
});

test('living actors and bombs continue for exactly three seconds after human death, then freeze', () => {
  const game = emptyGame();
  game.flames.push({ face: 0, x: 3, y: 3, ttl: 0.2 });
  game.update(0.05);
  assert.equal(game.status, 'lost');
  assert.equal(game.players[0].diedAt, 0.05);
  assert.equal(game.isRunning(), true);
  assert.equal(game.move(0, 1), false);
  assert.equal(game.placeBomb(0), false);
  assert.equal(game.move(1, 1), true);
  assert.equal(game.placeBomb(1), true);
  const pending = bomb(game, 5, 0, 0, 1, 4, 5);
  bomb(game, 2, 3, 3, 1, 0.7, 2);
  game.update(2.999);
  assert.equal(game.isRunning(), true);
  assert.equal(game.players[2].alive, false);
  assert.ok(game.players[2].diedAt > game.players[0].diedAt);
  assert.ok(Math.abs(pending.fuse - 1.001) < 1e-8);
  game.update(0.001);
  assert.equal(game.isRunning(), false);
  assert.ok(Math.abs(pending.fuse - 1) < 1e-8);
  const frozen = JSON.stringify({ players: game.players, bombs: game.bombs, flames: game.flames });
  assert.equal(game.move(3, 1), false);
  assert.equal(game.placeBomb(3), false);
  game.update(5);
  assert.equal(JSON.stringify({ players: game.players, bombs: game.bombs, flames: game.flames }), frozen);
  assert.equal(game.events.filter(event => event.type === 'end').length, 1);
});

test('explosions destroy bricks and can kill the owner; terminal state blocks controls', () => {
  const game = emptyGame();
  game.grid[0][3][4] = 2;
  game.placeBomb(0);
  game.update(2.7);
  assert.equal(game.grid[0][3][4], 0);
  assert.equal(game.players[0].alive, false);
  assert.equal(game.status, 'lost');
  assert.equal(game.move(0, 1), false);
  assert.equal(game.placeBomb(0), false);
  game.update(1);
  assert.equal(game.flames.length, 0);
});

test('the remaining human wins when all bots have been eliminated', () => {
  const game = emptyGame();
  game.players.slice(1).forEach(actor => { actor.alive = false; });
  game.update(0.05);
  assert.equal(game.status, 'won');
  assert.equal(game.players[0].place, 1);
  assert.deepEqual(game.events.at(-1), { type: 'end', status: 'won' });
});

test('the first human death is sixth place and reset clears recorded places', () => {
  const game = emptyGame();
  assert.ok(game.players.every(actor => actor.place === null));
  game.flames.push({ face: 0, x: 3, y: 3, ttl: 1 });
  game.update(0.05);
  assert.equal(game.players[0].place, 6);
  assert.equal(game.events.find(event => event.type === 'death').place, 6);
  game.reset();
  assert.ok(game.players.every(actor => actor.place === null));
});

test('human placement follows death order and stays fixed while others die during the animation', () => {
  const game = emptyGame();
  game.flames.push({ face: 1, x: 3, y: 3, ttl: 1 });
  game.update(0.05);
  assert.equal(game.players[1].place, 6);
  game.flames.push({ face: 0, x: 3, y: 3, ttl: 1 });
  game.update(0.05);
  assert.equal(game.players[0].place, 5);
  game.flames.push({ face: 2, x: 3, y: 3, ttl: 1 });
  game.update(0.05);
  assert.equal(game.players[2].place, 4);
  assert.equal(game.players[0].place, 5);
});

test('simultaneous deaths share the pre-explosion place and never create a dead first-place winner', () => {
  for (const aliveCount of [2, 6]) {
    const game = emptyGame();
    game.players.slice(aliveCount).forEach(actor => { actor.alive = false; });
    game.flames = game.players.slice(0, aliveCount).map(actor => ({ face: actor.face, x: actor.x, y: actor.y, ttl: 1 }));
    game.update(0.05);
    assert.equal(game.status, 'lost');
    assert.ok(game.players.slice(0, aliveCount).every(actor => actor.place === aliveCount));
    assert.ok(game.players.every(actor => actor.place !== 1));
  }
});

test('bots traverse faces, plant bombs, and avoid immediately killing themselves', () => {
  const game = emptyGame({ seed: 8312, bots: true });
  game.players[0].protectedUntil = 1000;
  game.update(15);
  assert.ok(game.events.some(event => event.type === 'move' && event.id > 0 && event.from.face !== event.to.face));
  assert.ok(game.events.some(event => event.type === 'bomb' && event.owner > 0));
  assert.ok(game.events.some(event => event.type === 'explode'));
  assert.ok(game.players.some(actor => actor.id > 0 && actor.alive));
});

test('bots open their dense spawn rooms by bombing bricks and taking cover', () => {
  const game = new Game({ seed: 8312, bots: true });
  game.players[0].protectedUntil = 1000;
  game.update(12);
  assert.ok(game.events.some(event => event.type === 'brick'));
  assert.ok(game.events.some(event => event.type === 'bomb' && event.owner > 0));
  assert.ok(game.players.some(actor => actor.id > 0 && actor.alive));
});
