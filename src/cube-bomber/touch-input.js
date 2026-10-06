/** Independent pointer ownership lets movement and a held bomb button coexist. */
export class TouchInputState {
  constructor() {
    this.directionPointers = new Map();
    this.bombPointers = new Set();
  }

  pressDirection(pointerId, dir) {
    if (!Number.isInteger(dir) || dir < 0 || dir > 3) return false;
    this.bombPointers.delete(pointerId);
    // Re-pressing or moving a pointer to another direction makes it the newest input.
    this.directionPointers.delete(pointerId);
    this.directionPointers.set(pointerId, dir);
    return true;
  }

  pressBomb(pointerId) {
    this.directionPointers.delete(pointerId);
    this.bombPointers.add(pointerId);
  }

  release(pointerId) {
    const directionReleased = this.directionPointers.delete(pointerId);
    const bombReleased = this.bombPointers.delete(pointerId);
    return directionReleased || bombReleased;
  }

  clear() {
    this.directionPointers.clear();
    this.bombPointers.clear();
  }

  get direction() {
    let result = null;
    for (const dir of this.directionPointers.values()) result = dir;
    return result;
  }

  get bombHeld() { return this.bombPointers.size > 0; }

  hasDirection(dir) {
    for (const held of this.directionPointers.values()) if (held === dir) return true;
    return false;
  }
}
