/* ── Web Audio API Sound Engine ── */

let ctx = null;

function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return ctx;
}

/* ── Ambient Mars Wind ── */
let windNode = null;
let windGain = null;

export function startWind() {
  const ac = getCtx();
  if (windNode) return;

  const bufferSize = ac.sampleRate * 4;
  const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
  const data = buffer.getChannelData(0);

  // Brown noise (integration of white noise) for deep wind
  let last = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }

  windNode = ac.createBufferSource();
  windNode.buffer = buffer;
  windNode.loop = true;

  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 200;

  windGain = ac.createGain();
  windGain.gain.value = 0.15;

  windNode.connect(filter);
  filter.connect(windGain);
  windGain.connect(ac.destination);
  windNode.start();
}

export function stopWind() {
  if (windNode) {
    windNode.stop();
    windNode = null;
    windGain = null;
  }
}

/* ── Thruster Sound ── */
let thrusterOsc = null;
let thrusterNoise = null;
let thrusterGain = null;

export function startThruster() {
  const ac = getCtx();
  if (thrusterGain) return;

  // Low rumble oscillator
  thrusterOsc = ac.createOscillator();
  thrusterOsc.type = 'sawtooth';
  thrusterOsc.frequency.value = 55;

  // Noise component
  const noiseLen = ac.sampleRate * 2;
  const noiseBuf = ac.createBuffer(1, noiseLen, ac.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;

  thrusterNoise = ac.createBufferSource();
  thrusterNoise.buffer = noiseBuf;
  thrusterNoise.loop = true;

  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 400;

  thrusterGain = ac.createGain();
  thrusterGain.gain.value = 0;

  const noiseGain = ac.createGain();
  noiseGain.gain.value = 0.3;

  thrusterOsc.connect(thrusterGain);
  thrusterNoise.connect(noiseGain);
  noiseGain.connect(filter);
  filter.connect(thrusterGain);
  thrusterGain.connect(ac.destination);

  thrusterOsc.start();
  thrusterNoise.start();
}

export function setThrusterLevel(level) {
  if (thrusterGain) {
    thrusterGain.gain.linearRampToValueAtTime(
      level * 0.35,
      getCtx().currentTime + 0.05
    );
  }
  if (thrusterOsc) {
    thrusterOsc.frequency.linearRampToValueAtTime(
      55 + level * 80,
      getCtx().currentTime + 0.05
    );
  }
}

export function stopThruster() {
  if (thrusterOsc) { thrusterOsc.stop(); thrusterOsc = null; }
  if (thrusterNoise) { thrusterNoise.stop(); thrusterNoise = null; }
  thrusterGain = null;
}

/* ── Warning Beep ── */
let beepInterval = null;

export function startWarningBeep(intervalMs = 800) {
  if (beepInterval) return;
  const ac = getCtx();

  beepInterval = setInterval(() => {
    const osc = ac.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 880;
    const g = ac.createGain();
    g.gain.value = 0.12;
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.15);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.15);
  }, intervalMs);
}

export function stopWarningBeep() {
  if (beepInterval) { clearInterval(beepInterval); beepInterval = null; }
}

/* ── Impact Sound ── */
export function playImpact(crashed) {
  const ac = getCtx();
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = crashed ? 60 : 120;
  const g = ac.createGain();
  g.gain.value = crashed ? 0.5 : 0.25;
  g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + (crashed ? 1.5 : 0.6));
  osc.connect(g);
  g.connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + (crashed ? 1.5 : 0.6));
}

/* ── Resume audio context (required after user gesture) ── */
export function resumeAudio() {
  const ac = getCtx();
  if (ac.state === 'suspended') ac.resume();
}

export function stopAll() {
  stopWind();
  stopThruster();
  stopWarningBeep();
}
