/* ── Web Audio API Sound Engine — ambience + UI cues ── */

let ctx = null;

function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return ctx;
}

/* ── Ambient wind (brown noise through a lowpass) ── */
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

/* ── Resume audio context (required after user gesture) ── */
export function resumeAudio() {
  const ac = getCtx();
  if (ac.state === 'suspended') ac.resume();
}

export function stopAll() {
  stopWind();
}

/* ── UI cues ──
 * Mute applies to UI cues and speech; ambience is governed by app phase.
 * Mute preference persists in localStorage.
 */

const MUTE_KEY = 'bhuvan.audio.muted';

let uiMuted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

export function isMuted() {
  return uiMuted;
}

export function toggleMute() {
  uiMuted = !uiMuted;
  try {
    localStorage.setItem(MUTE_KEY, uiMuted ? '1' : '0');
  } catch {
    // private mode — non-persistent mute is fine
  }
  if (uiMuted) {
    // Mute means silence: kill ambience + any speech, not just UI cues.
    window.speechSynthesis?.cancel();
    stopWind();
  } else {
    resumeAudio();
    startWind();
  }
  return uiMuted;
}

function blip({ freq = 880, duration = 0.06, type = 'square', gain = 0.04, when = 0 }) {
  if (uiMuted) return;
  const ac = getCtx();
  if (ac.state === 'suspended') ac.resume();
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  const t0 = ac.currentTime + when;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  amp.gain.setValueAtTime(gain, t0);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp);
  amp.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** Short neutral tick — layer switches, list selections. */
export function uiTick() {
  blip({ freq: 1320, duration: 0.04, gain: 0.03 });
}

/** Two-tone confirm — analysis complete, zone locked. */
export function uiConfirm() {
  blip({ freq: 740, duration: 0.07 });
  blip({ freq: 1108, duration: 0.09, when: 0.08 });
}

/** Descending two-tone — errors. */
export function uiAlert() {
  blip({ freq: 622, duration: 0.12, type: 'sawtooth', gain: 0.05 });
  blip({ freq: 415, duration: 0.16, type: 'sawtooth', gain: 0.05, when: 0.13 });
}
