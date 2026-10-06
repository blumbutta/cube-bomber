export const SIZE = 8;
export const BOMB_STEP_SECONDS = 1 / 3;
export const FACES = [
  { id: 0, name: 'Верх', n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { id: 1, name: 'Фронт', n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },
  { id: 2, name: 'Право', n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },
  { id: 3, name: 'Тыл', n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] },
  { id: 4, name: 'Лево', n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },
  { id: 5, name: 'Низ', n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
];

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const direction = (face, dir) => (dir % 2 ? face.u : face.v).map(value => value * (dir === 0 || dir === 3 ? -1 : 1));
export const tileKey = (face, x, y) => `${face}:${x}:${y}`;
const keyOf = cell => tileKey(cell.face, cell.x, cell.y);

export function worldPoint(face, x, y, height = 0) {
  const { n, u, v } = FACES[face];
  return n.map((value, i) => value * (SIZE / 2 + height) + u[i] * (x - (SIZE - 1) / 2) + v[i] * (y - (SIZE - 1) / 2));
}

/** A step unfolds across an edge; the returned direction is local to the new face. */
export function neighbor(face, x, y, dir) {
  const nextX = x + DX[dir];
  const nextY = y + DY[dir];
  if (nextX >= 0 && nextX < SIZE && nextY >= 0 && nextY < SIZE) return { face, x: nextX, y: nextY, dir };
  const source = FACES[face];
  const tangent = direction(source, dir);
  const target = FACES.find(candidate => dot(candidate.n, tangent) === 1);
  const point = worldPoint(face, x, y).map((value, i) => value + tangent[i] / 2 - source.n[i] / 2);
  const forward = source.n.map(value => -value);
  return {
    face: target.id,
    x: Math.round(dot(point, target.u) + (SIZE - 1) / 2),
    y: Math.round(dot(point, target.v) + (SIZE - 1) / 2),
    dir: [0, 1, 2, 3].find(candidate => dot(direction(target, candidate), forward) === 1),
  };
}

function seededRandom(seed) {
  let value = Number(seed) >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

export class Game {
  constructor({ seed = Date.now(), bots = true } = {}) {
    this.botsEnabled = bots;
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.random = seededRandom(seed);
    this.time = 0;
    this.status = 'playing';
    this.bombs = [];
    this.flames = [];
    this.bonuses = [];
    this.events = [];
    this.nextBombId = 1;
    this.grid = FACES.map(() => Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => {
      // The diagonal in this small spawn room provides cover for the first bomb.
      if ((x === 3 || x === 4) && (y === 3 || y === 4)) return 0;
      const perimeter = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      if (!perimeter && x % 2 === 0 && y % 2 === 0) return 1;
      const spawnRing = ((x === 2 || x === 5) && (y === 3 || y === 4)) || ((y === 2 || y === 5) && (x === 3 || x === 4));
      if (spawnRing) return 2;
      return this.random() < (perimeter ? 0.72 : 0.8) ? 2 : 0;
    })));
    const names = ['Вы · Ля-ля', 'Тинки-Винки', 'Дипси', 'По', 'Неон', 'Пикси'];
    this.players = FACES.map(face => ({
      id: face.id, name: names[face.id], face: face.id, x: 3, y: 3, dir: 2,
      alive: true, diedAt: null, range: 1, capacity: 1, speed: 1, moveCooldown: 0,
      previous: { face: face.id, x: 3, y: 3 }, movedAt: 0,
      protectedUntil: 1, botThink: 0.3 + this.random() * 0.8,
      targetId: null, targetUntil: 0, bombCooldown: 0,
    }));
    this.events.push({ type: 'reset', seed });
    return this;
  }

  moveDuration(actor) { return 0.3 / (1 + (actor.speed - 1) * 0.07); }

  isRunning() {
    return this.status === 'playing' || (this.status === 'lost' && this.players[0].diedAt !== null && this.time < this.players[0].diedAt + 3 - 1e-9);
  }

  canEnter(cell) {
    return this.grid[cell.face][cell.y][cell.x] === 0 && !this.bombs.some(bomb => keyOf(bomb) === keyOf(cell));
  }

  canBombEnter(cell) {
    return this.canEnter(cell) && !this.players.some(actor => actor.alive && keyOf(actor) === keyOf(cell));
  }

  advanceBomb(bomb) {
    const next = neighbor(bomb.face, bomb.x, bomb.y, bomb.dir);
    if (!this.canBombEnter(next)) { bomb.moving = false; return false; }
    bomb.previous = { face: bomb.face, x: bomb.x, y: bomb.y };
    bomb.face = next.face;
    bomb.x = next.x;
    bomb.y = next.y;
    bomb.dir = next.dir;
    bomb.movedAt = this.time;
    return true;
  }

  move(actorId, dir) {
    const actor = this.players.find(player => player.id === actorId);
    if (!actor || !actor.alive || !this.isRunning() || actor.moveCooldown > 0.0001 || !Number.isInteger(dir) || dir < 0 || dir > 3) return false;
    // The camera transports the input tangent, not the previous facing direction.
    const previousDir = dir;
    actor.dir = dir;
    const next = neighbor(actor.face, actor.x, actor.y, dir);
    if (!this.canEnter(next)) {
      const bomb = this.bombs.find(candidate => keyOf(candidate) === keyOf(next));
      if (!bomb || bomb.owner !== actor.id || this.grid[next.face][next.y][next.x] !== 0) return false;
      bomb.dir = next.dir;
      if (!this.advanceBomb(bomb)) return false;
      bomb.moving = true;
      bomb.moveAccumulator = 0;
      this.events.push({ type: 'kick', id: actor.id, bombId: bomb.id, face: bomb.face, x: bomb.x, y: bomb.y, dir: bomb.dir });
    }
    const from = { face: actor.face, x: actor.x, y: actor.y };
    const to = { face: next.face, x: next.x, y: next.y };
    actor.previous = from;
    actor.face = next.face;
    actor.x = next.x;
    actor.y = next.y;
    actor.dir = next.dir;
    actor.movedAt = this.time;
    actor.moveCooldown = Math.max(this.moveDuration(actor), from.face !== to.face ? 0.5 : 0);
    this.events.push({ type: 'move', id: actor.id, from, to, dir: next.dir, previousDir });
    this.collectBonus(actor);
    this.checkFlameDeaths();
    this.checkEnd();
    return true;
  }

  placeBomb(actorId) {
    const actor = this.players.find(player => player.id === actorId);
    if (!actor || !actor.alive || !this.isRunning() || this.bombs.some(bomb => keyOf(bomb) === keyOf(actor)) || this.bombs.filter(bomb => bomb.owner === actorId).length >= actor.capacity) return false;
    const bomb = { id: this.nextBombId++, owner: actorId, face: actor.face, x: actor.x, y: actor.y, range: actor.range, fuse: 2.7, moving: false, moveAccumulator: 0 };
    this.bombs.push(bomb);
    this.events.push({ type: 'bomb', ...bomb });
    return true;
  }

  blastCells(bomb) {
    const cells = [{ face: bomb.face, x: bomb.x, y: bomb.y }];
    const seen = new Set([keyOf(bomb)]);
    for (let dir = 0; dir < 4; dir++) {
      let cell = { face: bomb.face, x: bomb.x, y: bomb.y, dir };
      for (let distance = 0; distance < bomb.range; distance++) {
        cell = neighbor(cell.face, cell.x, cell.y, cell.dir);
        const tile = this.grid[cell.face][cell.y][cell.x];
        if (tile === 1) break;
        const key = keyOf(cell);
        if (!seen.has(key)) cells.push({ face: cell.face, x: cell.x, y: cell.y });
        seen.add(key);
        if (tile === 2 || this.bombs.some(other => other.id !== bomb.id && keyOf(other) === key)) break;
      }
    }
    return cells;
  }

  /** Earliest arrival of fire, including chain reactions. Active flames have time zero. */
  dangerMap() {
    const result = new Map();
    const burning = new Set(this.flames.map(keyOf));
    const times = this.bombs.map(bomb => burning.has(keyOf(bomb)) ? 0 : Math.max(0, bomb.fuse));
    const rays = this.bombs.map(bomb => this.blastCells(bomb));
    const bombIndex = new Map(this.bombs.map((bomb, i) => [keyOf(bomb), i]));
    for (let pass = 0; pass < this.bombs.length; pass++) {
      let changed = false;
      rays.forEach((cells, i) => cells.forEach(cell => {
        const j = bombIndex.get(keyOf(cell));
        if (j !== undefined && times[j] > times[i]) { times[j] = times[i]; changed = true; }
      }));
      if (!changed) break;
    }
    rays.forEach((cells, i) => cells.forEach(cell => {
      const key = keyOf(cell);
      result.set(key, Math.min(result.get(key) ?? Infinity, times[i]));
    }));
    this.flames.forEach(flame => result.set(keyOf(flame), 0));
    return result;
  }

  collectBonus(actor) {
    const index = this.bonuses.findIndex(bonus => keyOf(bonus) === keyOf(actor));
    if (index < 0) return;
    const [bonus] = this.bonuses.splice(index, 1);
    if (bonus.type === 'range') actor.range = Math.min(12, actor.range + 1);
    if (bonus.type === 'bomb') actor.capacity = Math.min(5, actor.capacity + 1);
    if (bonus.type === 'speed') actor.speed = Math.min(4, actor.speed + 1);
    this.events.push({ ...bonus, type: 'bonus', id: actor.id, bonus: bonus.type });
  }

  explode(bomb) {
    if (!this.bombs.includes(bomb)) return;
    const cells = this.blastCells(bomb);
    this.bombs.splice(this.bombs.indexOf(bomb), 1);
    const hit = new Set(cells.map(keyOf));
    const chained = this.bombs.filter(other => hit.has(keyOf(other)));
    for (const cell of cells) {
      const existing = this.flames.find(flame => keyOf(flame) === keyOf(cell));
      if (existing) existing.ttl = 0.75;
      else this.flames.push({ ...cell, ttl: 0.75 });
      const tile = this.grid[cell.face][cell.y][cell.x];
      if (tile === 2) {
        this.grid[cell.face][cell.y][cell.x] = 0;
        this.events.push({ type: 'brick', ...cell });
        if (this.random() < 0.45) {
          const bonusRoll = this.random();
          const type = bonusRoll < 0.65 ? 'bomb' : bonusRoll < 0.85 ? 'speed' : 'range';
          this.bonuses.push({ ...cell, type });
        }
      }
    }
    this.events.push({ type: 'explode', id: bomb.id, owner: bomb.owner, face: bomb.face, x: bomb.x, y: bomb.y, cells });
    chained.forEach(other => this.explode(other));
  }

  checkFlameDeaths() {
    const burning = new Set(this.flames.map(keyOf));
    for (const actor of this.players) {
      if (!actor.alive || this.time < actor.protectedUntil || !burning.has(keyOf(actor))) continue;
      actor.alive = false;
      actor.diedAt = this.time;
      this.events.push({ type: 'death', id: actor.id, face: actor.face, x: actor.x, y: actor.y, diedAt: actor.diedAt });
    }
  }

  checkEnd() {
    if (this.status !== 'playing') return;
    if (!this.players[0].alive) { this.players[0].diedAt ??= this.time; this.status = 'lost'; }
    else if (this.players.filter(player => player.alive).length === 1) this.status = 'won';
    if (this.status !== 'playing') this.events.push({ type: 'end', status: this.status });
  }

  /** Find the quickest surface route, including remaining and edge-crossing cooldowns. */
  findPath(actor, danger, goal, { escape = false, maxDepth = 48 } = {}) {
    const queue = [{ face: actor.face, x: actor.x, y: actor.y, depth: 0, firstDir: null, elapsed: actor.moveCooldown }];
    const earliest = new Map([[keyOf(actor), actor.moveCooldown]]);
    const step = this.moveDuration(actor);
    while (queue.length) {
      const cell = queue.shift();
      if (cell.elapsed > earliest.get(keyOf(cell)) + 1e-9) continue;
      if (cell.depth > 0 && goal(cell)) return cell;
      if (cell.depth >= maxDepth) continue;
      const offset = (actor.id + Math.floor(this.time / 3)) % 4;
      for (let i = 0; i < 4; i++) {
        const dir = (i + offset) % 4;
        const next = neighbor(cell.face, cell.x, cell.y, dir);
        const key = keyOf(next);
        if (!this.canEnter(next)) continue;
        const arrival = cell.elapsed + Math.max(step, cell.face !== next.face ? 0.5 : 0);
        if (arrival >= (earliest.get(key) ?? Infinity) - 1e-9) continue;
        const fireTime = danger.get(key);
        // Escape may cross a future ray while there is still enough time to leave it.
        if (fireTime !== undefined && (!escape || fireTime < arrival + step + 0.2)) continue;
        const sourceFire = danger.get(keyOf(cell));
        if (escape && sourceFire !== undefined && sourceFire < arrival + 0.1) continue;
        earliest.set(key, arrival);
        const queued = { ...next, depth: cell.depth + 1, firstDir: cell.firstDir ?? dir, elapsed: arrival };
        const insertAt = queue.findIndex(other => other.elapsed > arrival);
        if (insertAt < 0) queue.push(queued);
        else queue.splice(insertAt, 0, queued);
      }
    }
    return null;
  }

  canEscapeBomb(actor) {
    const hypothetical = { id: -1, owner: actor.id, face: actor.face, x: actor.x, y: actor.y, range: actor.range, fuse: 2.7 };
    this.bombs.push(hypothetical);
    const danger = this.dangerMap();
    const route = this.findPath(actor, danger, cell => !danger.has(keyOf(cell)), { escape: true, maxDepth: 8 });
    this.bombs.pop();
    return Boolean(route);
  }

  thinkBot(actor) {
    const danger = this.dangerMap();
    if (danger.has(keyOf(actor))) {
      const escape = this.findPath(actor, danger, cell => !danger.has(keyOf(cell)), { escape: true, maxDepth: 12 });
      if (escape) this.move(actor.id, escape.firstDir);
      return;
    }
    const preview = this.blastCells({ id: -1, face: actor.face, x: actor.x, y: actor.y, range: actor.range });
    const hit = new Set(preview.map(keyOf));
    const hitsOpponent = this.players.some(other => other.alive && other.id !== actor.id && hit.has(keyOf(other)));
    const hitsBrick = preview.some(cell => this.grid[cell.face][cell.y][cell.x] === 2);
    if (actor.bombCooldown <= 0 && (hitsOpponent || (hitsBrick && this.random() < 0.22)) && this.bombs.filter(bomb => bomb.owner === actor.id).length < actor.capacity && this.canEscapeBomb(actor)) {
      if (this.placeBomb(actor.id)) {
        actor.bombCooldown = 1.1 + this.random() * 0.8;
        const newDanger = this.dangerMap();
        const escape = this.findPath(actor, newDanger, cell => !newDanger.has(keyOf(cell)), { escape: true, maxDepth: 12 });
        if (escape) this.move(actor.id, escape.firstDir);
        return;
      }
    }
    const liveOthers = this.players.filter(other => other.alive && other.id !== actor.id);
    if (actor.targetUntil < this.time || !liveOthers.some(other => other.id === actor.targetId)) {
      actor.targetId = liveOthers[Math.floor(this.random() * liveOthers.length)]?.id;
      actor.targetUntil = this.time + 3 + this.random() * 4;
    }
    // Bonuses are useful local detours; enemies keep bots travelling between faces.
    const nearBonus = this.findPath(actor, danger, cell => this.bonuses.some(bonus => keyOf(bonus) === keyOf(cell)), { maxDepth: 4 });
    const target = this.players.find(other => other.id === actor.targetId);
    const route = nearBonus || (target && this.findPath(actor, danger, cell => keyOf(cell) === keyOf(target)));
    if (route) { this.move(actor.id, route.firstDir); return; }
    const offset = Math.floor(this.random() * 4);
    for (let i = 0; i < 4; i++) {
      const dir = (offset + i) % 4;
      const cell = neighbor(actor.face, actor.x, actor.y, dir);
      if (!danger.has(keyOf(cell)) && this.move(actor.id, dir)) return;
    }
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    let remaining = dt;
    while (remaining > 0.000001) {
      const running = this.isRunning();
      const untilDeathEnds = this.status === 'lost' && running ? this.players[0].diedAt + 3 - this.time : Infinity;
      const step = Math.min(remaining, 0.05, untilDeathEnds);
      remaining -= step;
      this.time += step;
      if (!running) continue;
      for (const actor of this.players) {
        actor.moveCooldown = Math.max(0, actor.moveCooldown - step);
        actor.bombCooldown = Math.max(0, actor.bombCooldown - step);
        actor.botThink -= step;
      }
      this.flames.forEach(flame => flame.ttl -= step);
      this.flames = this.flames.filter(flame => flame.ttl > 0);
      this.bombs.forEach(bomb => bomb.fuse -= step);
      for (const bomb of [...this.bombs]) {
        if (!this.bombs.includes(bomb)) continue;
        if (this.flames.some(flame => keyOf(flame) === keyOf(bomb))) { this.explode(bomb); continue; }
        if (!bomb.moving) continue;
        bomb.moveAccumulator = (bomb.moveAccumulator || 0) + step;
        while (bomb.moving && bomb.moveAccumulator >= BOMB_STEP_SECONDS - 0.00001) {
          bomb.moveAccumulator -= BOMB_STEP_SECONDS;
          this.advanceBomb(bomb);
          if (this.flames.some(flame => keyOf(flame) === keyOf(bomb))) {
            this.explode(bomb);
            break;
          }
        }
      }
      this.bombs.filter(bomb => bomb.fuse <= 0.00001).forEach(bomb => this.explode(bomb));
      this.checkFlameDeaths();
      this.checkEnd();
      if (this.botsEnabled && this.isRunning()) {
        for (const actor of this.players.slice(1)) {
          if (!actor.alive || actor.moveCooldown > 0.0001 || actor.botThink > 0) continue;
          this.thinkBot(actor);
          actor.botThink = this.moveDuration(actor) * (0.85 + this.random() * 0.15);
        }
      }
    }
  }
}
