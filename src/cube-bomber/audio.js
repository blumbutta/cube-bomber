const BPM = 108;
const STEP_SECONDS = 60 / BPM / 4;
const midi = note => 440 * 2 ** ((note - 69) / 12);
const VOICE_PITCHES = [320, 190, 245, 380, 285, 345];
const VOWELS = {
  eh: [520, 1840, 2600],
  oh: [430, 850, 2400],
  ah: [730, 1150, 2600],
  oo: [340, 730, 2150],
};

/** Original synthesized score and effects. Audio is created only by start(). */
export class GameAudio {
  constructor() {
    this._enabled = true;
    this._playing = false;
    this.context = null;
    this.master = null;
    this.musicBus = null;
    this.effectsBus = null;
    this.timer = null;
    this.nextStepTime = 0;
    this.step = 0;
    this.activeSources = new Set();
    this.lastExplosion = -Infinity;
    this.lastVoice = -Infinity;
    this.voiceNumber = 0;
    this.unavailable = false;
  }

  get enabled() { return this._enabled; }

  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this.context) return;
    this.ramp(this.master.gain, this._enabled ? 0.4 : 0, 0.018);
    if (!this._enabled) {
      this.stopSequencer();
      this.stopSources();
    } else if (this._playing && this.context.state === 'running') {
      this.beginSequencer();
    }
  }

  /** Call from a click / key gesture to satisfy browser autoplay requirements. */
  async start() {
    if (this.unavailable) return false;
    try {
      if (!this.context) this.createContext();
      if (!this.context) return false;
      if (this.context.state === 'suspended') await this.context.resume();
      this._playing = true;
      this.ramp(this.master.gain, this._enabled ? 0.4 : 0, 0.018);
      if (this._enabled && this.context.state === 'running') this.beginSequencer();
      return this.context.state === 'running';
    } catch {
      // The game remains fully playable on devices without usable WebAudio.
      this.unavailable = true;
      return false;
    }
  }

  setPlaying(playing) {
    this._playing = Boolean(playing);
    if (!this.context) return;
    if (this._playing && this._enabled && this.context.state === 'running') {
      this.beginSequencer();
    } else {
      this.ramp(this.musicBus.gain, 0, 0.025);
      this.stopSequencer();
      this.stopSources('music');
    }
  }

  createContext() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) { this.unavailable = true; return; }
    const context = new AudioContextClass();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = this._enabled ? 0.4 : 0;
    this.musicBus = context.createGain();
    this.musicBus.gain.value = 0;
    this.effectsBus = context.createGain();
    this.effectsBus.gain.value = 0.78;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 15;
    compressor.ratio.value = 7;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    this.musicBus.connect(compressor);
    this.effectsBus.connect(compressor);
    compressor.connect(this.master);
    this.master.connect(context.destination);

    this.noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }

  ramp(parameter, value, duration) {
    const now = this.context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(now);
    else { parameter.cancelScheduledValues(now); parameter.setValueAtTime(parameter.value, now); }
    parameter.linearRampToValueAtTime(value, now + duration);
  }

  track(source, group, end) {
    const record = { source, group };
    this.activeSources.add(record);
    source.onended = () => { this.activeSources.delete(record); source.disconnect(); };
    source.stop(end);
  }

  stopSources(group) {
    if (!this.context) return;
    const stopAt = this.context.currentTime + 0.03;
    for (const record of this.activeSources) {
      if (group && record.group !== group) continue;
      try { record.source.stop(stopAt); } catch { /* Already stopped. */ }
    }
  }

  tone({ time = this.context.currentTime, frequency, endFrequency = frequency, duration = 0.2, volume = 0.15, wave = 'sine', group = 'effects', cutoff = 0, attack = 0.008, pan = 0 }) {
    const context = this.context;
    const source = context.createOscillator();
    source.type = wave;
    source.frequency.setValueAtTime(frequency, time);
    if (endFrequency !== frequency) source.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), time + duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.linearRampToValueAtTime(volume, time + Math.min(attack, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    let output = source;
    if (cutoff) {
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(cutoff, time);
      filter.frequency.exponentialRampToValueAtTime(Math.max(130, cutoff / 3), time + duration);
      filter.Q.value = 0.8;
      output.connect(filter);
      output = filter;
    }
    output.connect(envelope);
    this.route(envelope, group, pan);
    source.start(time);
    this.track(source, group, time + duration + 0.02);
  }

  route(node, group, pan = 0) {
    const bus = group === 'music' ? this.musicBus : this.effectsBus;
    if (pan && this.context.createStereoPanner) {
      const panner = this.context.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner);
      panner.connect(bus);
    } else node.connect(bus);
  }

  noise({ time = this.context.currentTime, duration = 0.15, volume = 0.16, frequency = 1500, filterType = 'highpass', endFrequency = frequency, group = 'effects' }) {
    const context = this.context;
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), time + duration);
    filter.Q.value = 0.7;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.linearRampToValueAtTime(volume, time + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter);
    filter.connect(envelope);
    this.route(envelope, group);
    source.start(time, Math.random() * 0.5);
    this.track(source, group, time + duration + 0.02);
  }

  beginSequencer() {
    if (this.timer || !this.context || !this._enabled || !this._playing) return;
    this.nextStepTime = this.context.currentTime + 0.04;
    this.ramp(this.musicBus.gain, 0.26, 0.12);
    const schedule = () => {
      if (!this._enabled || !this._playing || this.context.state !== 'running') return;
      const now = this.context.currentTime;
      // Resume gracefully after a throttled background tab; never catch up in a burst.
      if (this.nextStepTime < now - STEP_SECONDS) this.nextStepTime = now + 0.03;
      while (this.nextStepTime < now + 0.12) {
        this.musicStep(this.step++, this.nextStepTime);
        this.nextStepTime += STEP_SECONDS;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 25);
  }

  stopSequencer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  musicStep(index, time) {
    const step = index % 16;
    const bar = Math.floor(index / 16);
    const root = [33, 36, 31, 38][bar % 4];
    if (step % 4 === 0 || (step === 14 && bar % 2 === 1)) {
      this.tone({ time, frequency: 132, endFrequency: 42, duration: 0.2, volume: 0.62, group: 'music', attack: 0.003 });
    }
    if (step === 4 || step === 12) {
      this.noise({ time, duration: 0.14, volume: 0.25, frequency: 1800, group: 'music' });
      this.tone({ time, frequency: 174, endFrequency: 125, duration: 0.11, volume: 0.2, group: 'music', wave: 'triangle' });
    }
    if (step % 2 === 0 || step === 11 || step === 15) {
      this.noise({ time, duration: step === 14 ? 0.12 : 0.045, volume: step % 4 === 2 ? 0.115 : 0.065, frequency: 6800, group: 'music' });
    }
    const bassNotes = { 0: 0, 3: 0, 6: 7, 8: 0, 10: 12, 14: 7 };
    if (Object.hasOwn(bassNotes, step)) {
      this.tone({ time, frequency: midi(root + bassNotes[step]), duration: step === 8 ? 0.26 : 0.19, volume: 0.33, group: 'music', wave: 'sawtooth', cutoff: 700, attack: 0.01 });
      this.tone({ time, frequency: midi(root + bassNotes[step] - 12), duration: 0.21, volume: 0.18, group: 'music' });
    }
    if (step % 2 === 1) {
      const pentatonic = [0, 7, 10, 12, 15, 12, 7, 5];
      const note = 57 + pentatonic[(Math.floor(step / 2) + bar * 2) % pentatonic.length];
      this.tone({ time, frequency: midi(note), duration: 0.24, volume: 0.105, group: 'music', wave: 'triangle', pan: step % 4 === 1 ? -0.32 : 0.32 });
      this.tone({ time: time + STEP_SECONDS * 1.5, frequency: midi(note), duration: 0.18, volume: 0.025, group: 'music', wave: 'sine', pan: step % 4 === 1 ? 0.4 : -0.4 });
    }
    if (step === 0) {
      const intervals = bar % 4 === 0 || bar % 4 === 3 ? [0, 3, 7] : [0, 4, 7];
      for (const [i, interval] of intervals.entries()) {
        this.tone({ time, frequency: midi(root + 24 + interval), duration: STEP_SECONDS * 15, volume: 0.058, group: 'music', wave: 'triangle', cutoff: 1200, attack: 0.3, pan: (i - 1) * 0.3 });
      }
    }
  }

  syllable(actorId, vowel, time, duration = 0.2, pitchScale = 1) {
    const context = this.context;
    const pitch = VOICE_PITCHES[((actorId % VOICE_PITCHES.length) + VOICE_PITCHES.length) % VOICE_PITCHES.length] * pitchScale;
    const source = context.createOscillator();
    source.type = 'sawtooth';
    source.frequency.setValueAtTime(pitch * 0.86, time);
    source.frequency.exponentialRampToValueAtTime(pitch * 1.08, time + duration * 0.35);
    source.frequency.exponentialRampToValueAtTime(pitch * 0.94, time + duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.linearRampToValueAtTime(0.25, time + 0.025);
    envelope.gain.setValueAtTime(0.18, time + duration * 0.55);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    for (const [i, frequency] of VOWELS[vowel].entries()) {
      const formant = context.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.setValueAtTime(frequency * (0.95 + actorId * 0.016), time);
      formant.Q.value = [4, 7, 9][i];
      const mix = context.createGain();
      mix.gain.value = [1, 0.58, 0.27][i];
      source.connect(formant);
      formant.connect(mix);
      mix.connect(envelope);
    }
    this.route(envelope, 'effects', actorId === 0 ? 0 : (actorId % 2 ? -0.18 : 0.18));
    this.tone({ time, frequency: pitch, endFrequency: pitch * 0.94, duration, volume: 0.035, wave: 'sine' });
    source.start(time);
    this.track(source, 'effects', time + duration + 0.03);
  }

  voice(actorId, time = this.context.currentTime, excited = false, force = false) {
    if (!force && time - this.lastVoice < 0.7) return;
    this.lastVoice = time;
    const patterns = [['eh', 'oh'], ['ah', 'oo'], ['oh', 'eh']];
    const pattern = patterns[this.voiceNumber++ % patterns.length];
    this.syllable(actorId, pattern[0], time, 0.18, excited ? 1.12 : 1);
    this.syllable(actorId, pattern[1], time + 0.19, excited ? 0.3 : 0.23, excited ? 1.28 : 0.91);
  }

  event(type, actorId = 0) {
    if (!this.context || !this._enabled || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    switch (type) {
      case 'start':
        this.tone({ time: now, frequency: 160, endFrequency: 640, duration: 0.22, volume: 0.13, wave: 'triangle' });
        this.voice(actorId, now + 0.12, true, true);
        break;
      case 'bomb':
        this.tone({ frequency: 220, endFrequency: 86, duration: 0.13, volume: 0.23, wave: 'sine' });
        this.tone({ time: now + 0.025, frequency: 820, duration: 0.055, volume: 0.065, wave: 'triangle' });
        break;
      case 'kick':
        this.noise({ duration: 0.08, frequency: 1200, volume: 0.12 });
        this.tone({ frequency: 420, endFrequency: 140, duration: 0.24, volume: 0.3, wave: 'triangle' });
        this.tone({ frequency: 180, endFrequency: 680, duration: 0.085, volume: 0.12 });
        if (Math.random() < 0.45) this.voice(actorId, now + 0.07, true);
        break;
      case 'explode':
        if (now - this.lastExplosion < 0.055) return;
        this.lastExplosion = now;
        this.noise({ duration: 0.68, volume: 0.56, frequency: 2400, endFrequency: 180, filterType: 'lowpass' });
        this.noise({ duration: 0.095, volume: 0.18, frequency: 3000 });
        this.tone({ frequency: 95, endFrequency: 28, duration: 0.6, volume: 0.55, attack: 0.003 });
        break;
      case 'bonus':
        [0, 7, 12].forEach((offset, i) => this.tone({ time: now + i * 0.075, frequency: midi(76 + offset), duration: 0.16, volume: 0.17, wave: 'triangle' }));
        this.voice(actorId, now + 0.1, true);
        break;
      case 'death':
        this.tone({ frequency: 510, endFrequency: 70, duration: 0.73, volume: 0.24, wave: 'triangle' });
        [0, 1, 2, 3].forEach(i => this.tone({ time: now + i * 0.12, frequency: 370 - i * 65, endFrequency: 160 - i * 25, duration: 0.17, volume: 0.105, wave: 'sine' }));
        this.syllable(actorId, 'oh', now + 0.1, 0.4, 0.72);
        break;
      case 'victory':
        [69, 72, 76, 81, 79, 81].forEach((note, i) => this.tone({ time: now + i * 0.13, frequency: midi(note), duration: i === 5 ? 0.55 : 0.25, volume: 0.23, wave: 'triangle', pan: (i % 2 ? 1 : -1) * 0.2 }));
        this.voice(actorId, now + 0.56, true, true);
        this.syllable(actorId, 'ah', now + 1.03, 0.36, 1.32);
        break;
      case 'voice':
        this.voice(actorId);
        break;
      default:
        break;
    }
  }
}
