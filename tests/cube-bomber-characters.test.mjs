import test from 'node:test';
import assert from 'node:assert/strict';
import { CHARACTERS, getCharacterOrder } from '../src/cube-bomber/characters.js';
import { Game } from '../src/cube-bomber/engine.js';

test('the default game roster uses the same new character names as the selector profiles', () => {
  assert.deepEqual(CHARACTERS.map(character => character.name), ['Люми', 'Бубо', 'Зип', 'Пип', 'Вольт', 'Физзи']);
  const game = new Game({ bots: false, seed: 27 });
  assert.deepEqual(game.players.map(actor => actor.name), CHARACTERS.map((character, index) => `${index === 0 ? 'Вы · ' : ''}${character.name}`));
});

test('each selected profile belongs to the human and the five other profiles remain unique', () => {
  for (const selected of CHARACTERS) {
    const order = getCharacterOrder(selected.id);
    assert.equal(order[0], selected.id);
    assert.equal(order.length, 6);
    assert.equal(new Set(order).size, 6);
    assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(order.slice(1), CHARACTERS.map(character => character.id).filter(id => id !== selected.id));
  }
});

test('invalid selections fall back to the default profile without coercing storage strings', () => {
  for (const selected of [undefined, null, false, true, '', '3', -1, 6, 1.5, NaN, Infinity, -Infinity, {}, []]) {
    assert.deepEqual(getCharacterOrder(selected), [0, 1, 2, 3, 4, 5]);
  }
});

test('callers cannot alter the shared profile identities or future order results', () => {
  const first = getCharacterOrder(3);
  first.reverse();
  assert.deepEqual(getCharacterOrder(3), [3, 0, 1, 2, 4, 5]);
  assert.throws(() => { CHARACTERS[3].id = 0; }, TypeError);
  assert.throws(() => { CHARACTERS.push({ id: 6 }); }, TypeError);
});

test('assigning any human appearance preserves every actor game statistic and spawn', () => {
  const expectedGame = new Game({ bots: false, seed: 27 });
  const stats = actor => ({
    id: actor.id, face: actor.face, x: actor.x, y: actor.y,
    range: actor.range, capacity: actor.capacity, speed: actor.speed,
    alive: actor.alive, duration: expectedGame.moveDuration(actor),
  });
  const expected = expectedGame.players.map(stats);
  for (const selected of CHARACTERS) {
    const game = new Game({ bots: false, seed: 27 });
    const order = getCharacterOrder(selected.id);
    const roster = game.players.map(actor => ({ actor, character: CHARACTERS[order[actor.id]] }));
    assert.equal(roster[0].actor.id, 0);
    assert.equal(roster[0].character.id, selected.id);
    assert.deepEqual(roster.map(entry => stats(entry.actor)), expected);
    assert.deepEqual(game.grid, expectedGame.grid);
  }
});
