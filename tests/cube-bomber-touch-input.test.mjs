import test from 'node:test';
import assert from 'node:assert/strict';
import { TouchInputState } from '../src/cube-bomber/touch-input.js';

test('two fingers can hold movement and repeatedly use bombs without clearing either control', () => {
  const input = new TouchInputState();
  input.pressDirection(11, 1);
  input.pressBomb(27);
  assert.equal(input.direction, 1);
  assert.equal(input.bombHeld, true);
  // Bomb finger lifts while the movement finger remains down.
  input.release(27);
  assert.equal(input.direction, 1);
  assert.equal(input.bombHeld, false);
  input.pressBomb(29);
  assert.equal(input.direction, 1);
  assert.equal(input.bombHeld, true);
  // Movement finger then lifts without releasing the bomb finger.
  input.release(11);
  assert.equal(input.direction, null);
  assert.equal(input.bombHeld, true);
  input.release(29);
  assert.equal(input.bombHeld, false);
});

test('releasing an older direction preserves the newest direction and a held bomb', () => {
  const input = new TouchInputState();
  input.pressDirection(10, 0);
  input.pressDirection(20, 1);
  input.pressBomb(30);
  assert.equal(input.direction, 1);
  assert.equal(input.hasDirection(0), true);
  assert.equal(input.hasDirection(1), true);
  input.release(10);
  assert.equal(input.direction, 1);
  assert.equal(input.hasDirection(0), false);
  assert.equal(input.bombHeld, true);
  input.release(20);
  assert.equal(input.direction, null);
  assert.equal(input.bombHeld, true);
});

test('releasing the newest direction falls back to the older finger still held down', () => {
  const input = new TouchInputState();
  input.pressDirection(1, 3);
  input.pressDirection(2, 2);
  assert.equal(input.direction, 2);
  input.release(2);
  assert.equal(input.direction, 3);
  input.pressDirection(3, 0);
  input.pressDirection(1, 1);
  assert.equal(input.direction, 1, 'An updated pointer becomes the newest direction');
  input.release(1);
  assert.equal(input.direction, 0);
});

test('multiple bomb fingers remain held until the final pointer releases', () => {
  const input = new TouchInputState();
  input.pressBomb(0);
  input.pressBomb(1);
  input.release(0);
  assert.equal(input.bombHeld, true);
  input.release(999);
  assert.equal(input.bombHeld, true);
  input.release(1);
  assert.equal(input.bombHeld, false);
});

test('pointer cancellation and lost capture are idempotent and clearing all input resets every control', () => {
  const input = new TouchInputState();
  input.pressDirection(1, 0);
  input.pressDirection(2, 2);
  input.pressBomb(3);
  assert.equal(input.release(2), true); // pointercancel
  assert.equal(input.release(2), false); // subsequent lostpointercapture
  assert.equal(input.direction, 0);
  assert.equal(input.bombHeld, true);
  input.clear(); // blur, pause, scene switch, or visibility loss
  assert.equal(input.direction, null);
  assert.equal(input.bombHeld, false);
  assert.equal(input.hasDirection(0), false);
  assert.equal(input.directionPointers.size, 0);
  assert.equal(input.bombPointers.size, 0);
});

test('a pointer switching controls relinquishes its previous control without affecting other fingers', () => {
  const input = new TouchInputState();
  input.pressDirection(1, 2);
  input.pressDirection(2, 3);
  input.pressBomb(1);
  assert.equal(input.direction, 3);
  assert.equal(input.bombHeld, true);
  input.pressDirection(1, 0);
  assert.equal(input.direction, 0);
  assert.equal(input.bombHeld, false);
  assert.equal(input.hasDirection(3), true);
  assert.equal(input.pressDirection(3, 4), false);
  assert.equal(input.pressDirection(3, 1.5), false);
  assert.equal(input.direction, 0);
});
