import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZE, BOMB_STEP_SECONDS, FACES, Game, neighbor, tileKey, worldPoint } from '../src/cube-bomber/engine.js';

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
function position(actor, face, x, y) { Object.assign(actor, { face, x, y, moveCooldown: 0 }); }

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

test('a kicked bomb meeting existing fire detonates immediately without waiting for its fuse', () => {
  const game = emptyGame();
  position(game.players[0], 0, 2, 3);
  bomb(game, 0, 3, 3, 1, 2.7);
  game.flames.push({ face: 0, x: 4, y: 3, ttl: 0.75 });
  assert.equal(game.move(0, 1), true);
  assert.equal(game.dangerMap().get('0:4:2'), 0);
  game.update(0.05);
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
  assert.deepEqual(game.events.at(-1), { type: 'end', status: 'won' });
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
