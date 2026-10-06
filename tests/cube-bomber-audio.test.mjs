import test from 'node:test';
import assert from 'node:assert/strict';
import { GameAudio } from '../src/cube-bomber/audio.js';

class AudioParamMock {
  constructor() { this.value = 0; this.events = []; }
  setValueAtTime(value, time) { this.events.push(['set', value, time]); this.value = value; }
  exponentialRampToValueAtTime(value, time) { assert.ok(value > 0); this.events.push(['exponential', value, time]); this.value = value; }
  linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); this.value = value; }
  cancelAndHoldAtTime(time) { this.events.push(['hold', time]); }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
}

class AudioNodeMock {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
    this.startCalls = [];
    this.stopCalls = [];
    for (const name of ['frequency', 'detune', 'gain', 'Q', 'pan', 'threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = new AudioParamMock();
  }
  connect(node) { assert.ok(node); this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
  start(time = 0, offset = 0) { this.startCalls.push({ time, offset }); }
  stop(time) { this.stopCalls.push(time); }
}

function installAudio(t, { state = 'running', resume } = {}) {
  const original = globalThis.AudioContext;
  class AudioContextMock {
    constructor() {
      this.state = state;
      this.currentTime = 1;
      this.sampleRate = 44100;
      this.sources = [];
      this.destination = new AudioNodeMock('destination');
      this.resumeCalls = 0;
    }
    createGain() { return new AudioNodeMock('gain'); }
    createBiquadFilter() { return new AudioNodeMock('filter'); }
    createStereoPanner() { return new AudioNodeMock('panner'); }
    createDynamicsCompressor() { return new AudioNodeMock('compressor'); }
    createOscillator() { const node = new AudioNodeMock('oscillator'); this.sources.push(node); return node; }
    createBufferSource() { const node = new AudioNodeMock('noise'); this.sources.push(node); return node; }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    async resume() {
      this.resumeCalls++;
      if (resume) return resume(this, this.resumeCalls);
      this.state = 'running';
      this.onstatechange?.();
    }
  }
  globalThis.AudioContext = AudioContextMock;
  t.after(() => {
    if (original === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = original;
  });
  const audio = new GameAudio();
  t.after(() => audio.setEnabled(false));
  return audio;
}

test('allowed menu autoplay starts music without requiring a resume or a gesture', async t => {
  const audio = installAudio(t);
  assert.equal(audio.context, null);
  assert.equal(audio.isReady, false);
  assert.equal(await audio.start({ autoplay: true }), true);
  assert.equal(audio.isReady, true);
  assert.equal(audio.context.resumeCalls, 0);
  assert.ok(audio.timer);
  assert.ok([...audio.activeSources].some(record => record.group === 'music'));
});

test('blocked autoplay returns promptly and the first gesture unlocks the same context', async t => {
  const audio = installAudio(t, { state: 'suspended' });
  assert.equal(await audio.start({ autoplay: true }), false);
  const context = audio.context;
  assert.equal(context.resumeCalls, 0);
  assert.equal(audio.timer, null);
  assert.equal(audio.unavailable, false);
  assert.equal(await audio.start(), true);
  assert.equal(audio.context, context);
  assert.equal(context.resumeCalls, 1);
  assert.equal(audio.isReady, true);
  assert.ok(audio.timer);
});

test('a transient NotAllowedError does not prevent a later successful gesture', async t => {
  const audio = installAudio(t, {
    state: 'suspended',
    resume: (context, attempt) => {
      if (attempt === 1) throw Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' });
      context.state = 'running';
      context.onstatechange?.();
    },
  });
  assert.equal(await audio.start(), false);
  assert.equal(audio.unavailable, false);
  assert.equal(await audio.start(), true);
  assert.equal(audio.context.resumeCalls, 2);
});

test('a browser that leaves resume pending cannot hang start; a later unlock still starts music', { timeout: 1500 }, async t => {
  const audio = installAudio(t, { state: 'suspended', resume: () => new Promise(() => {}) });
  assert.equal(await audio.start(), false);
  assert.equal(audio.unavailable, false);
  audio.context.state = 'running';
  audio.context.onstatechange();
  assert.equal(audio.isReady, true);
  assert.ok(audio.timer);
});

test('mute prevents autoplay and selection sounds; pause and unmute preserve the requested music state', async t => {
  const audio = installAudio(t);
  audio.setEnabled(false);
  assert.equal(await audio.start({ autoplay: true }), true);
  assert.equal(audio.enabled, false);
  assert.equal(audio.timer, null);
  audio.event('select', 0);
  assert.equal(audio.context.sources.length, 0);
  audio.setEnabled(true);
  assert.ok(audio.timer);
  audio.event('select', 0);
  assert.ok(audio.activeSources.size > 0);
  audio.setEnabled(false);
  assert.equal(audio.activeSources.size, 0);
  assert.equal(audio.master.gain.value, 0);
  audio.setPlaying(false);
  audio.setEnabled(true);
  assert.equal(audio.timer, null);
  audio.setPlaying(true);
  assert.ok(audio.timer);
});

test('six character signatures differ in rhythm and timbre as well as pitch', async t => {
  const audio = installAudio(t);
  await audio.start();
  audio.setPlaying(false);
  const rhythms = new Set();
  const signatures = [];
  for (let id = 0; id < 6; id++) {
    const from = audio.context.sources.length;
    audio.event('select', id);
    const sources = audio.context.sources.slice(from);
    const starts = [...new Set(sources.flatMap(source => source.startCalls.map(call => Number((call.time - audio.context.currentTime).toFixed(3)))))].sort((a, b) => a - b);
    rhythms.add(JSON.stringify(starts));
    signatures.push(sources);
  }
  assert.equal(rhythms.size, 6, 'Voice variety must include six different rhythms, not only six transpositions');
  assert.equal(new Set(signatures[0].flatMap(source => source.startCalls.map(call => call.time))).size, 3, 'Lumi sings three notes');
  assert.equal(new Set(signatures[1].flatMap(source => source.startCalls.map(call => call.time))).size, 2, 'Bubo has two slow vowels');
  assert.ok(Math.max(...signatures[1].flatMap(source => source.stopCalls)) - audio.context.currentTime > 0.85);
  assert.ok(Math.max(...signatures[3].flatMap(source => source.stopCalls)) - audio.context.currentTime < 0.5, 'Pip has a brief ascending signature');
  assert.ok(signatures[4].some(source => source.type === 'square'), 'Volt uses a robotic waveform');
  assert.ok(signatures[5].some(source => source.kind === 'noise'), 'Fizzy includes airy breath');
});

test('rapid selection cancels the previous preview, bypasses the voice cooldown, and preserves other sound effects', async t => {
  const audio = installAudio(t);
  await audio.start();
  audio.setPlaying(false);
  audio.event('voice', 0);
  audio.event('bomb', 0);
  const effects = [...audio.activeSources].filter(record => record.group === 'effects');
  audio.event('select', 1);
  const previous = [...audio.activeSources].filter(record => record.group === 'preview');
  assert.ok(previous.length > 0, 'Selection must bypass the just-used ambient voice cooldown');
  audio.context.currentTime += 0.02;
  audio.event('select', 3);
  for (const record of previous) {
    assert.equal(record.source.stopCalls.at(-1), audio.context.currentTime);
    assert.equal(audio.activeSources.has(record), false);
  }
  assert.ok([...audio.activeSources].some(record => record.group === 'preview'));
  assert.ok(effects.every(record => audio.activeSources.has(record)));
});

test('start, voice, death, and victory retain the selected character signature', async t => {
  const audio = installAudio(t);
  await audio.start();
  audio.setPlaying(false);
  const calls = [];
  audio.syllable = (...args) => calls.push(args);
  for (const type of ['start', 'voice', 'death', 'victory']) {
    audio.lastVoice = -Infinity;
    calls.length = 0;
    audio.event(type, 4);
    assert.equal(calls.length, 3, `${type} keeps Volt's three-part signature`);
    assert.ok(calls.every(args => args[0] === 4 && args[5].timbre === 'robot'));
    if (type === 'death') assert.ok(calls.every(args => args[5].falling));
  }
});


test('collapse countdown is brief; falling metal has a sustained rumble and obeys mute', async t => {
  const audio = installAudio(t);
  await audio.start();
  audio.setPlaying(false);
  let start = audio.context.sources.length;
  audio.event('collapse-tick');
  const tick = audio.context.sources.slice(start);
  assert.ok(tick.length > 0);
  assert.ok(tick.every(source => Math.max(...source.stopCalls) - audio.context.currentTime < 0.3));
  start = audio.context.sources.length;
  audio.event('collapse');
  const collapse = audio.context.sources.slice(start);
  assert.ok(collapse.some(source => source.kind === 'noise'));
  assert.ok(collapse.some(source => source.stopCalls.some(end => end - audio.context.currentTime >= 1.5)));
  assert.ok(collapse.some(source => source.startCalls.some(call => call.time - audio.context.currentTime >= 0.69)), 'The falling panel has a delayed impact');
  audio.setEnabled(false);
  start = audio.context.sources.length;
  audio.event('collapse');
  audio.event('collapse-tick');
  assert.equal(audio.context.sources.length, start);
});
