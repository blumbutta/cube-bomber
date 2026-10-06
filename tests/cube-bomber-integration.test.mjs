import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FACES, SIZE, FACE_COLLAPSE_INTERVAL, neighbor, tileKey, movementProgress, flameVulnerableCells } from '../src/cube-bomber/engine.js';

const key = cell => tileKey(cell.face, cell.x, cell.y);
const oppositeFace = [5, 3, 4, 1, 2, 0];
function clearGame() {
  const game = new Game({ bots: false, seed: 17 });
  game.grid = FACES.map(() => Array.from({ length: SIZE }, () => Array(SIZE).fill(0)));
  game.players.forEach(actor => actor.protectedUntil = 0);
  game.events.length = 0;
  return game;
}
function edgePosition(face, dir) {
  return { face, x: dir === 1 ? 7 : dir === 3 ? 0 : 3, y: dir === 2 ? 7 : dir === 0 ? 0 : 3 };
}

test('crossing events preserve the departure direction for camera-relative controls after a turn', () => {
  for (const face of FACES) for (let departure = 0; departure < 4; departure++) for (let facing = 0; facing < 4; facing++) {
    const game = new Game({ bots: false, seed: 17 });
    game.grid = FACES.map(() => Array.from({ length: SIZE }, () => Array(SIZE).fill(0)));
    const actor = game.players[0];
    const x = departure === 1 ? 7 : departure === 3 ? 0 : 3;
    const y = departure === 2 ? 7 : departure === 0 ? 0 : 3;
    Object.assign(actor, { face: face.id, x, y, dir: facing, moveCooldown: 0 });
    const next = neighbor(face.id, x, y, departure);
    assert.equal(game.move(0, departure), true);
    const event = game.events.find(item => item.type === 'move');
    const viewTurn = (event.dir - event.previousDir + 4) % 4;
    // Keeping the same screen direction held must continue forward on the new face.
    assert.equal((departure + viewTurn) % 4, next.dir,
      `face ${face.id}, previous facing ${facing}, departure ${departure}`);
  }
});

test('place, step away, return, and kick crosses every cube edge at three cells per second without resetting the fuse', () => {
  for (const face of FACES) for (let dir = 0; dir < 4; dir++) {
    const game = clearGame();
    const edge = edgePosition(face.id, dir);
    Object.assign(game.players[0], edge);
    game.players.slice(1).forEach(actor => actor.face = oppositeFace[face.id]);
    assert.equal(game.placeBomb(0), true);
    assert.equal(game.move(0, (dir + 2) % 4), true);
    game.update(.3);
    const fuse = game.bombs[0].fuse;
    assert.equal(game.move(0, dir), true);
    const bomb = game.bombs[0];
    let expected = neighbor(edge.face, edge.x, edge.y, dir);
    assert.notEqual(bomb.face, edge.face);
    assert.equal(key(bomb), key(expected));
    assert.equal(bomb.fuse, fuse);
    game.update(1 / 3 - .01);
    assert.equal(key(bomb), key(expected), 'a rolling bomb must stay in its cell until the next one-third-second step');
    game.update(1 / 3 + .01);
    for (let step = 0; step < 2; step++) expected = neighbor(expected.face, expected.x, expected.y, expected.dir);
    assert.equal(key(bomb), key(expected));
    assert.equal(bomb.dir, expected.dir);
    assert.ok(Math.abs(bomb.fuse - (fuse - 2 / 3)) < 1e-8);
  }
});

test('fire crosses every cube edge and kills a remote actor while respecting the exact range', () => {
  for (const face of FACES) for (let dir = 0; dir < 4; dir++) {
    const game = clearGame();
    const origin = edgePosition(face.id, dir);
    const first = neighbor(origin.face, origin.x, origin.y, dir);
    const second = neighbor(first.face, first.x, first.y, first.dir);
    const outside = neighbor(second.face, second.x, second.y, second.dir);
    Object.assign(game.players[0], { face: oppositeFace[face.id], x: 3, y: 3 });
    Object.assign(game.players[1], second);
    Object.assign(game.players[2], outside);
    game.bombs.push({ id: 1, ...origin, range: 2, fuse: .1, owner: 3, moving: false });
    game.update(.1);
    assert.equal(game.players[1].alive, false, `edge ${face.id}/${dir}`);
    assert.equal(game.players[2].alive, true, `outside range ${face.id}/${dir}`);
    assert.ok(game.flames.some(cell => key(cell) === key(second)));
    assert.ok(!game.flames.some(cell => key(cell) === key(outside)));
  }
});

test('simultaneous human and last-bot deaths cannot emit a false victory', () => {
  const game = clearGame();
  game.players.slice(2).forEach(actor => actor.alive = false);
  Object.assign(game.players[0], { face: 0, x: 2, y: 3 });
  Object.assign(game.players[1], { face: 0, x: 4, y: 3 });
  game.bombs.push({ id: 1, face: 0, x: 3, y: 3, range: 1, fuse: .1, owner: 0, moving: false });
  game.update(.1);
  assert.equal(game.players.filter(actor => actor.alive).length, 0);
  assert.equal(game.status, 'lost');
  assert.deepEqual(game.events.filter(event => event.type === 'end'), [{ type: 'end', status: 'lost' }]);
  game.update(2);
  assert.equal(game.events.filter(event => event.type === 'end').length, 1);
});

test('bots keep fighting during the human death animation and controls stop after three seconds', () => {
  const game = clearGame();
  game.botsEnabled = true;
  // Isolate one real AI attacker and a stationary target so its post-death actions are deterministic.
  game.players.slice(1).forEach(actor => actor.botThink = 1000);
  Object.assign(game.players[1], { face: 1, x: 3, y: 3, botThink: 0 });
  Object.assign(game.players[2], { face: 1, x: 4, y: 3 });
  const human = game.players[0];
  game.bombs.push({ id: game.nextBombId++, face: human.face, x: human.x, y: human.y,
    range: 1, fuse: .05, owner: 0, moving: false });

  game.update(.05);
  assert.equal(human.alive, false);
  assert.equal(game.status, 'lost');
  assert.equal(human.diedAt, game.time);
  assert.equal(game.move(0, 1), false, 'dead human cannot move');
  assert.equal(game.placeBomb(0), false, 'dead human cannot plant a bomb');
  assert.ok(game.events.some(event => event.type === 'bomb' && event.owner === 1), 'living AI plants after the human dies');
  assert.ok(game.events.some(event => event.type === 'move' && event.id === 1), 'living AI moves away from its bomb');

  game.update(2.72);
  assert.equal(game.players[2].alive, false, 'the newly placed bomb still explodes and kills another bot');
  assert.ok(game.players[2].diedAt > human.diedAt);
  assert.ok(game.players[2].diedAt < human.diedAt + 3);
  assert.equal(game.players[3].alive, true);
  assert.equal(game.placeBomb(3), true, 'a living bot can still place a bomb just before the animation ends');

  const pending = game.bombs.find(bomb => bomb.owner === 3);
  game.update(human.diedAt + 3.01 - game.time);
  const position = key(game.players[3]);
  const fuse = pending.fuse;
  assert.equal(game.move(3, 1), false, 'bot movement is blocked once the three-second death window ends');
  assert.equal(game.placeBomb(4), false, 'bot planting is blocked once the three-second death window ends');
  game.update(1);
  assert.equal(key(game.players[3]), position);
  assert.equal(pending.fuse, fuse, 'remaining bombs no longer count down after the death window');
  assert.equal(game.events.filter(event => event.type === 'end').length, 1);
  assert.equal(game.status, 'lost', 'later bot deaths never change the human loss into a win');
});

function inverseSmooth(progress) {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration++) {
    const midpoint = (low + high) / 2;
    if (midpoint * midpoint * (3 - 2 * midpoint) < progress) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

test('human and bot flame collisions track the 20% and 80% animation boundaries over every cube edge', () => {
  const cases = [
    { progress: .199, burning: 'destination', survives: true },
    { progress: .2, burning: 'destination', survives: true },
    { progress: .201, burning: 'destination', survives: false },
    { progress: .799, burning: 'source', survives: false },
    { progress: .8, burning: 'source', survives: true },
    { progress: .801, burning: 'source', survives: true },
  ];
  for (const actorId of [0, 1]) for (const face of FACES) for (let dir = 0; dir < 4; dir++) for (const scenario of cases) {
    const game = clearGame();
    const source = edgePosition(face.id, dir);
    const destination = neighbor(source.face, source.x, source.y, dir);
    const actor = game.players[actorId];
    Object.assign(actor, source);
    const label = `actor ${actorId}, edge ${face.id}/${dir}, ${scenario.burning} at ${scenario.progress}`;
    assert.equal(game.move(actorId, dir), true, label);
    assert.equal(actor.stepDuration, .5, label);
    assert.equal(movementProgress(actor, game.time), 0, 'a just-started step has no visual progress');

    game.update(actor.stepDuration * inverseSmooth(scenario.progress));
    assert.ok(Math.abs(movementProgress(actor, game.time) - scenario.progress) < 1e-10, label);
    const burningCell = scenario.burning === 'source' ? source : destination;
    const vulnerable = new Set(flameVulnerableCells(actor, game.time).map(key));
    assert.equal(vulnerable.has(key(burningCell)), !scenario.survives, label);
    game.flames.push({ face: burningCell.face, x: burningCell.x, y: burningCell.y, ttl: .75 });
    game.checkFlameDeaths();
    assert.equal(actor.alive, scenario.survives, label);
  }
});

test('starting a step into fire has entry grace on all cube edges for both human and bot', () => {
  for (const actorId of [0, 1]) for (const face of FACES) for (let dir = 0; dir < 4; dir++) {
    const game = clearGame();
    const source = edgePosition(face.id, dir);
    const destination = neighbor(source.face, source.x, source.y, dir);
    const actor = game.players[actorId];
    Object.assign(actor, source);
    game.flames.push({ face: destination.face, x: destination.x, y: destination.y, ttl: .75 });
    assert.equal(game.move(actorId, dir), true);
    assert.equal(actor.alive, true, `actor ${actorId} entering edge ${face.id}/${dir}`);
    game.update(.1);
    assert.equal(actor.alive, true, 'less than 20% visible progress is still safe');
    game.update(.05);
    assert.equal(actor.alive, false, 'entering more than 20% into existing fire is lethal');
  }
});

test('stationary human and bot are still vulnerable to fire on their current cell on every face', () => {
  for (const actorId of [0, 1]) for (const face of FACES) {
    const game = clearGame();
    const actor = game.players[actorId];
    const cell = { face: face.id, x: 3, y: 3 };
    Object.assign(actor, cell, { previous: { ...cell } });
    assert.equal(movementProgress(actor, game.time), 1);
    assert.deepEqual(flameVulnerableCells(actor, game.time), [cell]);
    game.flames.push({ ...cell, ttl: .75 });
    game.checkFlameDeaths();
    assert.equal(actor.alive, false);
  }
});

test('a player bomb chains a freshly kicked foreign bomb at its visible source cell', () => {
  const game = clearGame();
  const source = { id: game.nextBombId++, owner: 0, face: 0, x: 5, y: 2, range: 1, fuse: .01, moving: false };
  const foreign = { id: game.nextBombId++, owner: 1, face: 0, x: 5, y: 3, range: 1, fuse: 2.7, moving: false };
  game.bombs.push(source, foreign);
  Object.assign(game.players[1], { face: 0, x: 4, y: 3, moveCooldown: 0 });
  assert.equal(game.move(1, 1), true);
  assert.equal(foreign.x, 6, 'the rolling bomb reserves its destination immediately');
  game.update(.01);
  assert.equal(game.bombs.length, 0, 'foreign ownership must not prevent a visual blast contact from chaining');
  const exploded = game.events.filter(event => event.type === 'explode');
  assert.deepEqual(exploded.map(event => event.owner), [0, 1]);
  const foreignExplosion = exploded.find(event => event.id === foreign.id);
  assert.deepEqual([foreignExplosion.face, foreignExplosion.x, foreignExplosion.y], [0, 5, 3],
    'a bomb still visibly near its source must also explode from that source');
});

test('fire reaches a foreign rolling bomb across every edge while its visible body is still on the source face', () => {
  for (const face of FACES) for (let dir = 0; dir < 4; dir++) {
    const game = clearGame();
    const source = edgePosition(face.id, dir);
    const kicker = neighbor(source.face, source.x, source.y, (dir + 2) % 4);
    const foreign = { id: game.nextBombId++, owner: 1, ...source, range: 1, fuse: 2.7, moving: false };
    game.bombs.push(foreign);
    Object.assign(game.players[1], kicker, { moveCooldown: 0 });
    assert.equal(game.move(1, dir), true);
    assert.notEqual(foreign.face, source.face);
    game.flames.push({ ...source, ttl: .75 });
    game.update(.01);
    const explosion = game.events.find(event => event.type === 'explode' && event.id === foreign.id);
    assert.ok(explosion, `existing fire must hit the visible source on edge ${face.id}/${dir}`);
    assert.equal(key(explosion), key(source));
    assert.equal(explosion.owner, 1);
    assert.equal(game.bombs.length, 0);
  }
});

test('rolling into existing fire detonates on visual contact rather than immediately on destination reservation', () => {
  const game = clearGame();
  const source = edgePosition(0, 1);
  const destination = neighbor(source.face, source.x, source.y, 1);
  const foreign = { id: game.nextBombId++, owner: 1, ...source, range: 1, fuse: 2.7, moving: false };
  Object.assign(game.players[1], { face: 0, x: 6, y: 3, moveCooldown: 0 });
  game.bombs.push(foreign);
  game.flames.push({ face: destination.face, x: destination.x, y: destination.y, ttl: .75 });
  assert.equal(game.move(1, 1), true);
  game.update(.05);
  assert.ok(game.bombs.includes(foreign), 'under 20% visible entry into the destination fire has not touched it yet');
  game.update(.05);
  assert.equal(game.bombs.length, 0, 'the rolling body now overlaps destination fire');
  const explosion = game.events.find(event => event.type === 'explode' && event.id === foreign.id);
  assert.equal(key(explosion), key(source), 'the visible center is still nearer its source at the moment of contact');
});

test('stopping a rolling bomb does not hide the final visible source overlap from existing fire', () => {
  const game = clearGame();
  const foreign = { id: game.nextBombId++, owner: 1, face: 0, x: 5, y: 3, range: 1, fuse: 2.7, moving: false };
  game.bombs.push(foreign);
  Object.assign(game.players[1], { face: 0, x: 4, y: 3, moveCooldown: 0 });
  assert.equal(game.move(1, 1), true);
  game.update(.1);
  game.grid[0][3][7] = 1;
  assert.equal(game.advanceBomb(foreign), false);
  assert.equal(foreign.moving, false);
  game.flames.push({ face: 0, x: 5, y: 3, ttl: .75 });
  game.update(.01);
  assert.equal(game.bombs.length, 0);
  const explosion = game.events.find(event => event.type === 'explode' && event.id === foreign.id);
  assert.deepEqual([explosion.face, explosion.x, explosion.y], [0, 5, 3]);
});

function adjacentFaces(face) {
  return new Set([0, 1, 2, 3].map(dir => {
    const edge = edgePosition(face, dir);
    return neighbor(edge.face, edge.x, edge.y, dir).face;
  }));
}

function assertConnectedFaces(active) {
  const visited = new Set([active[0]]);
  const queue = [active[0]];
  for (let index = 0; index < queue.length; index++) for (const face of adjacentFaces(queue[index])) {
    if (active.includes(face) && !visited.has(face)) { visited.add(face); queue.push(face); }
  }
  assert.equal(visited.size, active.length, `active faces must remain connected: ${active.join(', ')}`);
}

test('scheduled collapses warn ten seconds early, follow neighboring faces, and preserve the final connected arena', () => {
  for (const seed of [17, 999]) {
    const game = clearGame();
    game.reset(seed);
    let previousFace = null;
    for (let collapseIndex = 0; collapseIndex < 5; collapseIndex++) {
      const scheduled = { ...game.nextCollapse };
      assert.ok(Math.abs(scheduled.at - (collapseIndex + 1) * FACE_COLLAPSE_INTERVAL) < 1e-8);
      assert.ok(game.isFaceActive(scheduled.face));
      if (previousFace !== null) assert.ok(adjacentFaces(previousFace).has(scheduled.face));
      const safeFace = FACES.find(face => game.isFaceActive(face.id) && face.id !== scheduled.face).id;
      // Keep all six actors alive so winner detection does not end the scheduling scenario early.
      game.players.forEach(actor => Object.assign(actor, {
        face: safeFace, x: 3, y: 3, previous: { face: safeFace, x: 3, y: 3 },
        movedAt: game.time, stepDuration: 0, moveCooldown: 0,
      }));
      game.update(scheduled.at - 10 - .01 - game.time);
      assert.equal(game.events.filter(event => event.type === 'collapse-warning' && event.face === scheduled.face).length, 0);
      game.update(.02);
      assert.equal(game.events.filter(event => event.type === 'collapse-warning' && event.face === scheduled.face).length, 1);
      assert.ok(game.isFaceActive(scheduled.face));
      game.update(scheduled.at - game.time);
      assert.equal(game.collapsedFaces.size, collapseIndex + 1);
      assert.ok(!game.isFaceActive(scheduled.face));
      assert.ok(Math.abs(game.faceCollapses.get(scheduled.face) - scheduled.at) < 1e-8);
      assert.equal(game.events.filter(event => event.type === 'collapse' && event.face === scheduled.face).length, 1);
      assertConnectedFaces(FACES.filter(face => game.isFaceActive(face.id)).map(face => face.id));
      previousFace = scheduled.face;
    }
    assert.equal(game.nextCollapse, null);
    const finalFace = FACES.find(face => game.isFaceActive(face.id)).id;
    game.update(130);
    assert.equal(game.collapsedFaces.size, 5);
    assert.equal(game.isFaceActive(finalFace), true);
    assert.equal(game.events.filter(event => event.type === 'collapse').length, 5);
  }
});

test('collapse uses the same inclusive 20% entry and 80% exit grace on all cube edges', () => {
  const cases = [
    { progress: .199, doomedSide: 'destination', survives: true },
    { progress: .2, doomedSide: 'destination', survives: true },
    { progress: .201, doomedSide: 'destination', survives: false },
    { progress: .799, doomedSide: 'source', survives: false },
    { progress: .8, doomedSide: 'source', survives: true },
    { progress: .801, doomedSide: 'source', survives: true },
  ];
  for (const actorId of [0, 1]) for (const face of FACES) for (let dir = 0; dir < 4; dir++) {
    for (const { progress, doomedSide, survives } of cases) {
      const game = clearGame();
      const source = edgePosition(face.id, dir);
      const destination = neighbor(source.face, source.x, source.y, dir);
      const safeFace = FACES.find(candidate => candidate.id !== source.face && candidate.id !== destination.face).id;
      game.players.forEach(actor => Object.assign(actor, { face: safeFace, x: 3, y: 3, previous: { face: safeFace, x: 3, y: 3 } }));
      const actor = game.players[actorId];
      Object.assign(actor, source);
      assert.equal(game.move(actorId, dir), true);
      const doomed = doomedSide === 'source' ? source.face : destination.face;
      game.nextCollapse = { face: doomed, at: actor.stepDuration * inverseSmooth(progress) };
      const label = `actor ${actorId}, edge ${face.id}/${dir}, ${doomedSide} collapses at ${progress}`;
      game.update(game.nextCollapse.at - game.time);
      assert.equal(actor.alive, survives, label);
      assert.equal(game.isFaceActive(doomed), false, label);
      if (!survives) {
        assert.equal(actor.place, 6, label);
        const death = game.events.find(event => event.type === 'death' && event.id === actorId);
        assert.equal(death.face, doomed, 'collapse deaths must be rendered on the falling face, even when the logical actor cell is across the edge');
        assert.equal(key(death), key(doomedSide === 'source' ? source : destination));
        continue;
      }
      assert.ok(game.isFaceActive(actor.face), label);
      assert.equal(actor.face, doomedSide === 'destination' ? source.face : destination.face, label);
      if (doomedSide === 'destination') {
        assert.equal(key(actor), key(source), 'an early entering survivor must be returned to its active source cell');
        assert.equal(actor.moveCooldown, 0, 'an aborted edge crossing must not leave a stuck cooldown');
        const returned = game.events.find(event => event.type === 'collapse-return' && event.id === actorId);
        assert.ok(returned);
        assert.equal(actor.dir, dir, 'the returned actor must regain its original local direction');
        assert.equal(returned.previousDir, destination.dir);
        assert.equal(returned.dir, dir);
        assert.equal(game.move(actorId, dir), false, 'the survivor cannot immediately reenter the destroyed destination');
      }
    }
  }
});

test('every boundary with a collapsed face blocks actors, kicked bombs, and explosion rays', () => {
  for (const face of FACES) for (let dir = 0; dir < 4; dir++) {
    const game = clearGame();
    const edge = edgePosition(face.id, dir);
    const voidCell = neighbor(edge.face, edge.x, edge.y, dir);
    const safeFace = FACES.find(candidate => candidate.id !== voidCell.face).id;
    game.players.forEach(actor => Object.assign(actor, { face: safeFace, x: 3, y: 3, previous: { face: safeFace, x: 3, y: 3 } }));
    game.nextCollapse = { face: voidCell.face, at: .01 };
    game.update(.01);
    const actor = game.players[0];
    Object.assign(actor, edge, { previous: { ...edge }, moveCooldown: 0, stepDuration: 0 });
    assert.equal(game.move(0, dir), false, `actor cannot cross ${face.id}/${dir} into void`);
    assert.equal(game.placeBomb(0), true);
    const bomb = game.bombs[0];
    bomb.range = 12;
    const rays = game.blastCells(bomb);
    assert.ok(rays.length > 1);
    assert.ok(rays.every(cell => game.isFaceActive(cell.face)), 'long rays stop at destroyed faces instead of passing through');
    const kicker = neighbor(edge.face, edge.x, edge.y, (dir + 2) % 4);
    Object.assign(actor, kicker, { previous: { face: kicker.face, x: kicker.x, y: kicker.y }, moveCooldown: 0, stepDuration: 0 });
    assert.equal(game.move(0, dir), false, `bomb cannot be kicked across ${face.id}/${dir} into void`);
    assert.equal(key(bomb), key(edge));
  }
});
