// ── BHUVAN Mission Ops — telemetry bus ──────────────────────────────
//
// Source-agnostic telemetry bus. TODAY the source is an in-browser lander
// simulator; TOMORROW swap `_source` for a WebSocket / CCSDS adapter and the
// subscribers (dashboard, digital twin, event log) never change. That
// decoupling — one bus, many subscribers, hot-swappable source — is the
// system-design contract this whole console is built on.
//
// Packet shape is CCSDS-flavoured: { apid, t, mode, params:{...}, ... }.

export const PARAM_META = {
  battery_pct: { label: 'BATTERY', unit: '%', warnLo: 30, critLo: 15 },
  power_w:     { label: 'POWER',   unit: 'W' },
  temp_c:      { label: 'TEMP',    unit: '°C', warnHi: 55, critHi: 70, warnLo: -45, critLo: -65 },
  tilt_deg:    { label: 'TILT',    unit: '°',  warnHi: 12, critHi: 20 },
  signal_dbm:  { label: 'SIGNAL',  unit: 'dBm', warnLo: -112, critLo: -126 },
};

/** Limit check → 'NOMINAL' | 'WARN' | 'CRITICAL' (FDIR rule engine, no ML). */
export function evalAlarm(key, value) {
  const L = PARAM_META[key];
  if (!L || value == null) return 'NOMINAL';
  if ((L.critHi != null && value >= L.critHi) || (L.critLo != null && value <= L.critLo)) return 'CRITICAL';
  if ((L.warnHi != null && value >= L.warnHi) || (L.warnLo != null && value <= L.warnLo)) return 'WARN';
  return 'NOMINAL';
}

class TelemetryBus {
  constructor() { this.subs = new Set(); }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  publish(packet) { this.subs.forEach((fn) => fn(packet)); }
}

// Commands the operator can uplink. Each maps to a mode/action the executor
// applies on the next tick, then telemetry reacts — a closed command loop.
export const COMMANDS = [
  { id: 'drive',   type: 'MODE', mode: 'DRIVING',  label: 'DRIVE TO LZ' },
  { id: 'science', type: 'MODE', mode: 'SCIENCE',  label: 'RUN SCIENCE' },
  { id: 'charge',  type: 'MODE', mode: 'CHARGING', label: 'SOLAR CHARGE' },
  { id: 'comm',    type: 'MODE', mode: 'COMM',     label: 'DSN DOWNLINK' },
  { id: 'idle',    type: 'MODE', mode: 'IDLE',     label: 'STANDBY' },
  { id: 'safe',    type: 'SAFE',                   label: 'SAFE MODE',  danger: true },
];

class LanderSim {
  constructor() {
    this.bus = new TelemetryBus();
    this.events = [];
    this.eventSubs = new Set();
    this.queue = [];
    this._timer = null;
    this._refs = 0;
    this._alarms = {};
    this.state = {
      met: 0, mode: 'IDLE',
      battery_pct: 86, power_w: 22, temp_c: -18, tilt_deg: 3.1,
      heading_deg: 117, signal_dbm: -96, comms: true,
      lat: -69.37, lon: 32.32, sunElev: 0.35,
    };
  }

  // Refcounted so multiple panels can mount/unmount without killing the feed.
  start() {
    if (this._refs++ === 0) {
      this._timer = setInterval(() => this._tick(), 500); // 2 Hz
      this._log('INFO', 'Telemetry link acquired · BHUVAN-1 lander');
    }
  }
  stop() {
    if (--this._refs <= 0) {
      clearInterval(this._timer);
      this._timer = null;
      this._refs = 0;
    }
  }

  subscribe(fn) { return this.bus.subscribe(fn); }
  onEvent(fn) { this.eventSubs.add(fn); fn(this.events); return () => this.eventSubs.delete(fn); }
  getState() { return this.state; }

  command(cmd) {
    this.queue.push(cmd);
    this._log('CMD', `Uplink queued: ${cmd.label}`);
  }

  _log(sev, msg) {
    const e = { t: this.state.met, sev, msg, id: `${this.state.met.toFixed(1)}-${Math.random().toString(36).slice(2, 7)}` };
    this.events.unshift(e);
    if (this.events.length > 80) this.events.pop();
    this.eventSubs.forEach((fn) => fn(this.events));
  }

  _exec(c) {
    if (c.type === 'SAFE') { this.state.mode = 'IDLE'; this._log('WARN', 'SAFE MODE entered — instruments powered down'); return; }
    if (c.type === 'MODE') { this.state.mode = c.mode; this._log('INFO', `Mode → ${c.mode}`); }
  }

  _tick() {
    const s = this.state;
    s.met += 0.5;
    s.sunElev = Math.sin(s.met / 140) * 0.5 + 0.38;
    const inSun = s.sunElev > 0.12;

    if (this.queue.length) this._exec(this.queue.shift());

    switch (s.mode) {
      case 'DRIVING':
        s.battery_pct -= 0.28; s.power_w = 76 + Math.sin(s.met) * 7;
        s.tilt_deg = 3 + Math.abs(Math.sin(s.met / 2.4)) * 10;
        s.heading_deg = (s.heading_deg + 1.6) % 360; s.lat += 0.0006; break;
      case 'CHARGING':
        s.battery_pct += inSun ? 0.42 : 0.015; s.power_w = inSun ? 11 : 4; break;
      case 'SCIENCE':
        s.battery_pct -= 0.13; s.power_w = 54 + Math.sin(s.met / 2) * 5; break;
      case 'COMM':
        s.battery_pct -= 0.09; s.power_w = 47; break;
      default:
        s.battery_pct -= 0.025; s.power_w = 21;
    }
    s.battery_pct = Math.max(0, Math.min(100, s.battery_pct));

    const targetT = inSun ? 49 : -58;
    s.temp_c += (targetT - s.temp_c) * 0.02;
    if (s.mode !== 'DRIVING') s.tilt_deg += (3.1 - s.tilt_deg) * 0.06;

    s.comms = Math.sin(s.met / 95) > -0.25;
    s.signal_dbm = s.comms ? -90 - Math.random() * 16 : -132;

    this._checkAlarms();

    this.bus.publish({
      apid: 0x64,
      t: s.met,
      mode: s.mode,
      comms: s.comms,
      sunElev: s.sunElev,
      pos: { lat: s.lat, lon: s.lon, heading: s.heading_deg },
      params: {
        battery_pct: +s.battery_pct.toFixed(1),
        power_w: Math.round(s.power_w),
        temp_c: +s.temp_c.toFixed(1),
        tilt_deg: +s.tilt_deg.toFixed(1),
        signal_dbm: Math.round(s.signal_dbm),
      },
    });
  }

  _checkAlarms() {
    const s = this.state;
    ['battery_pct', 'temp_c', 'tilt_deg', 'signal_dbm'].forEach((k) => {
      const a = evalAlarm(k, s[k]);
      const prev = this._alarms[k] || 'NOMINAL';
      if (a !== prev && a !== 'NOMINAL') {
        this._log(a === 'CRITICAL' ? 'CRIT' : 'WARN', `${PARAM_META[k].label} ${a} · ${(+s[k]).toFixed(1)}${PARAM_META[k].unit}`);
      }
      this._alarms[k] = a;
    });
  }
}

// Singleton bus — the one source of truth every subscriber shares.
export const missionControl = new LanderSim();

/** Format mission elapsed time (seconds) as HH:MM:SS. */
export function formatMET(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
