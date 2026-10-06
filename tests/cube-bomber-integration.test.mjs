import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, FACES, SIZE, neighbor, tileKey } from '../src/cube-bomber/engine.js';

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
