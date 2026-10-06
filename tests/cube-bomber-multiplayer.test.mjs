import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CubeRoomManager, RECONNECT_MS } from '../server/rooms.mjs';
import { createCubeServer } from '../server/socket.mjs';
import { FACES, SIZE, neighbor } from '../src/cube-bomber/engine.js';
import { CubeClient, applySnapshot, websocketUrl } from '../src/cube-bomber/network.js';

function connection() {
  return { messages: [], send(packet) { this.messages.push(typeof packet === 'string' ? JSON.parse(packet) : structuredClone(packet)); }, close() {} };
}
function fixtures() {
  let now = 10_000;
  const manager = new CubeRoomManager({ now: () => now });
  const advance = ms => { for (let left = ms; left > 0;) { const step = Math.min(50, left); now += step; left -= step; manager.advance(); } };
  return { manager, advance, jump(ms) { now += ms; manager.advance(); } };
}
const latest = (connection, type) => connection.messages.filter(packet => packet.type === type).at(-1);

test('cube room caps, host authority, private codes, unique characters, and reconnect reservation', () => {
  const { manager, advance } = fixtures();
  const clients = Array.from({ length: 7 }, connection);
  const room = manager.receive(clients[0], { type: 'create', characterId: 3, nickname: 'Хозяин' });
  assert.match(room.id, /^[A-F0-9]{8}$/);
  for (let index = 1; index < 6; index++) manager.receive(clients[index], { type: 'join', roomId: room.id, characterId: 3 });
  assert.equal(new Set(room.slots.map(slot => slot.characterId)).size, 6);
  assert.equal(room.slots[0].characterId, 3);
  manager.receive(clients[6], { type: 'join', roomId: room.id });
  assert.equal(latest(clients[6], 'error').code, 'room_full');
  manager.receive(clients[1], { type: 'start' });
  assert.equal(latest(clients[1], 'error').code, 'host_only');
  manager.receive(clients[1], { type: 'select', characterId: 3 });
  assert.equal(latest(clients[1], 'error').code, 'character_taken');
  const token = latest(clients[0], 'welcome').reconnectToken;
  const memberId = clients[0].member.id;
  manager.disconnect(clients[0]);
  assert.equal(room.hostId, clients[1].member.id);
  const returning = connection(); manager.receive(returning, { type: 'join', roomId: room.id, reconnectToken: token });
  assert.equal(returning.member.id, memberId);
  assert.equal(returning.member.playerId, 0);
  assert.equal(room.hostId, clients[1].member.id);
  manager.disconnect(returning); advance(RECONNECT_MS);
  const expired = connection(); manager.receive(expired, { type: 'join', roomId: room.id, reconnectToken: token });
  assert.equal(latest(expired, 'error').code, 'reconnect_expired');
  assert.equal(room.members.size, 5);
});

test('cube active-room limit is independent and empty rooms clean up after the reconnect grace', () => {
  const { manager, advance } = fixtures();
  const clients = Array.from({ length: 5 }, connection);
  const rooms = clients.slice(0, 4).map(client => manager.receive(client, { type: 'create' }));
  manager.receive(clients[4], { type: 'create' }); assert.equal(latest(clients[4], 'error').code, 'server_busy');
  manager.receive(clients[0], { type: 'start' }); assert.equal(rooms[0].phase, 'countdown');
  manager.receive(clients[1], { type: 'start' }); assert.equal(latest(clients[1], 'error').code, 'server_busy');
  advance(2999); assert.equal(rooms[0].game.time, 0);
  advance(1); assert.equal(rooms[0].phase, 'playing');
  assert.equal(rooms[0].game.humanIds.size, 1);
  for (const client of clients.slice(0, 4)) manager.disconnect(client);
  advance(RECONNECT_MS + 1000); assert.equal(manager.rooms.size, 0);
});

test('server owns actor identity and movement, transports held direction across an edge, and clears stale input', () => {
  const { manager, advance } = fixtures();
  const clients = Array.from({ length: 6 }, connection);
  const room = manager.receive(clients[0], { type: 'create' });
  clients.slice(1).forEach(client => manager.receive(client, { type: 'join', roomId: room.id }));
  manager.receive(clients[0], { type: 'start' }); advance(3000);
  const game = room.game;
  game.grid = FACES.map(() => Array.from({ length: SIZE }, () => Array(SIZE).fill(0)));
  Object.assign(game.players[0], { face: 0, x: 7, y: 3, moveCooldown: 0 });
  const other = { ...game.players[1] };
  manager.receive(clients[0], { type: 'input', seq: 1, dir: 1, playerId: 1, actorId: 1, x: 99, range: 99 });
  advance(50);
  const across = neighbor(0, 7, 3, 1);
  assert.deepEqual([game.players[0].face, game.players[0].x, game.players[0].y], [across.face, across.x, across.y]);
  assert.equal(clients[0].member.input.dir, across.dir);
  assert.deepEqual([game.players[1].face, game.players[1].x, game.players[1].y], [other.face, other.x, other.y]);
  assert.equal(game.players[0].range, 1);
  manager.receive(clients[0], { type: 'input', seq: 1, dir: 3 });
  assert.equal(clients[0].member.input.dir, across.dir, 'replayed inputs cannot override a newer command');
  advance(500); assert.equal(clients[0].member.input.dir, null);
  const stopped = [game.players[0].face, game.players[0].x, game.players[0].y];
  advance(1000); assert.deepEqual([game.players[0].face, game.players[0].x, game.players[0].y], stopped);
  const state = latest(clients[0], 'state');
  const copy = applySnapshot(Object.create(Object.getPrototypeOf(game)), state.state);
  assert.ok(copy.humanIds instanceof Set); assert.ok(copy.faceCollapses instanceof Map);
  assert.deepEqual(copy.faceBounds, game.faceBounds); assert.equal(copy.multiplayer, true);
  assert.ok(state.events.every(event => Number.isInteger(event.eventId)));
});

async function peer(url) {
  const socket = new WebSocket(url, { origin: 'http://localhost' });
  const messages = []; const waiters = [];
  socket.on('message', data => {
    const packet = JSON.parse(data.toString()); messages.push(packet);
    for (let index = waiters.length - 1; index >= 0; index--) if (waiters[index].predicate(packet)) {
      const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timeout); waiter.resolve(packet);
    }
  });
  await once(socket, 'open');
  return { socket, messages, send(packet) { socket.send(JSON.stringify(packet)); },
    wait(predicate) {
      const present = messages.find(predicate); if (present) return Promise.resolve(present);
      return new Promise((resolve, reject) => { const waiter = { predicate, resolve }; waiter.timeout = setTimeout(() => reject(new Error('WebSocket response timed out')), 2000); waiters.push(waiter); });
    },
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 15));

test('six real WebSocket clients share authoritative play, foreign-bomb chains, and reconnect identity', async t => {
  const clock = fixtures(); const app = createCubeServer({ manager: clock.manager });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `ws://127.0.0.1:${app.server.address().port}/cube-ws`;
  const peers = [];
  t.after(() => { peers.forEach(peer => peer.socket.terminate()); app.close(); });
  for (let index = 0; index < 6; index++) peers.push(await peer(url));
  peers[0].send({ type: 'create', nickname: 'Первый', characterId: 0 });
  const welcome = await peers[0].wait(packet => packet.type === 'welcome');
  for (let index = 1; index < 6; index++) { peers[index].send({ type: 'join', roomId: welcome.roomId, nickname: `Игрок ${index}`, characterId: index }); await peers[index].wait(packet => packet.type === 'welcome'); }
  await peers[0].wait(packet => packet.type === 'room' && packet.members.length === 6);
  peers[0].send({ type: 'start' }); await peers[0].wait(packet => packet.type === 'room' && packet.phase === 'countdown');
  clock.advance(3000); await peers[0].wait(packet => packet.type === 'room' && packet.phase === 'playing');
  const room = clock.manager.rooms.get(welcome.roomId), game = room.game;
  assert.equal(game.humanIds.size, 6);
  game.grid = FACES.map(() => Array.from({ length: SIZE }, () => Array(SIZE).fill(0)));
  game.players.forEach(player => player.protectedUntil = 100);
  Object.assign(game.players[0], { face: 0, x: 3, y: 3, capacity: 2 });
  Object.assign(game.players[1], { face: 0, x: 4, y: 3 });
  peers[0].send({ type: 'bomb', seq: 1, playerId: 5, range: 99 });
  peers[1].send({ type: 'bomb', seq: 1 }); await flush();
  assert.deepEqual(game.bombs.map(bomb => bomb.owner).sort(), [0, 1]);
  assert.equal(game.bombs[0].range, 1);
  Object.assign(game.players[0], { face: 0, x: 2, y: 3 });
  peers[0].send({ type: 'bomb', seq: 1 }); await flush(); assert.equal(game.bombs.length, 2);
  game.bombs.find(bomb => bomb.owner === 0).fuse = .05;
  clock.advance(50);
  const state = await peers[5].wait(packet => packet.type === 'state' && packet.events?.filter(event => event.type === 'explode').length === 2);
  assert.equal(state.state.bombs.length, 0);
  assert.deepEqual(state.events.filter(event => event.type === 'explode').map(event => event.owner).sort(), [0, 1]);
  const closed = once(peers[0].socket, 'close'); peers[0].socket.close(); await closed; await flush();
  assert.equal(game.humanIds.has(0), false);
  assert.equal(room.hostId, room.memberForSlot(1).id);
  const resumed = await peer(url); peers.push(resumed);
  resumed.send({ type: 'join', roomId: welcome.roomId, reconnectToken: welcome.reconnectToken });
  const restored = await resumed.wait(packet => packet.type === 'welcome');
  assert.equal(restored.playerId, 0); assert.equal(restored.memberId, welcome.memberId);
  assert.equal(game.humanIds.has(0), true);
});

test('network endpoint normalization and WebSocket origin/payload protection', async t => {
  assert.equal(websocketUrl('https://kozlogon-server.onrender.com'), 'wss://kozlogon-server.onrender.com/cube-ws');
  const app = createCubeServer(); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}/cube-ws`;
  const denied = new WebSocket(url, { origin: 'https://not-the-game.invalid' });
  const [error] = await once(denied, 'error'); assert.match(error.message, /403/);
  const valid = await peer(url); t.after(() => valid.socket.terminate());
  valid.send({ type: 'create', nickname: 'x'.repeat(3000) });
  const [code] = await once(valid.socket, 'close'); assert.equal(code, 1009);
});

test('cancelling a pending client connection settles it and an old close cannot erase its replacement', async () => {
  const NativeWebSocket = globalThis.WebSocket;
  const sockets = [];
  class DeferredSocket {
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000 })); }
    send() {}
    open() { this.readyState = 1; this.onopen?.(); }
  }
  globalThis.WebSocket = DeferredSocket;
  const client = new CubeClient();
  try {
    const cancelled = client.connect(); const cancellation = assert.rejects(cancelled, /прервано/);
    client.close();
    const replacement = client.connect();
    await cancellation;
    const duplicateWait = client.connect();
    assert.equal(sockets.length, 2, 'closing the old socket must not permit duplicate pending connections');
    sockets[1].open();
    await replacement; await duplicateWait;
    assert.equal(client.connected, true);
  } finally { client.destroy(); await Promise.resolve(); globalThis.WebSocket = NativeWebSocket; }
});
