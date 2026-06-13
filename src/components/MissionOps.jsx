import React, { useEffect, useRef, useState } from 'react';
import { missionControl, COMMANDS, PARAM_META, evalAlarm, formatMET } from '../engine/telemetry';

const HISTORY = 48;

// Live telemetry hook: starts the bus, keeps the latest packet in state and a
// rolling per-parameter history (ref, no re-render churn) for sparklines.
function useMissionTelemetry() {
  const [packet, setPacket] = useState(() => null);
  const histRef = useRef({});

  useEffect(() => {
    missionControl.start();
    const off = missionControl.subscribe((p) => {
      const h = histRef.current;
      Object.entries(p.params).forEach(([k, v]) => {
        (h[k] = h[k] || []).push(v);
        if (h[k].length > HISTORY) h[k].shift();
      });
      setPacket(p);
    });
    return () => { off(); missionControl.stop(); };
  }, []);

  return { packet, history: histRef.current };
}

function useEvents() {
  const [events, setEvents] = useState([]);
  useEffect(() => missionControl.onEvent((e) => setEvents([...e])), []);
  return events;
}

// Tiny inline sparkline — normalized to its own min/max window.
function Sparkline({ data, state }) {
  if (!data || data.length < 2) return <svg className="ops-spark" viewBox="0 0 100 28" preserveAspectRatio="none" />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${28 - ((v - min) / span) * 24 - 2}`)
    .join(' ');
  return (
    <svg className={`ops-spark ${state.toLowerCase()}`} viewBox="0 0 100 28" preserveAspectRatio="none">
      <polyline points={pts} fill="none" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TelemetryTile({ tkey, value, history }) {
  const meta = PARAM_META[tkey];
  const state = evalAlarm(tkey, value);
  return (
    <div className={`ops-tile ${state.toLowerCase()}`}>
      <div className="ops-tile-head">
        <span className="ops-tile-label">{meta.label}</span>
        <span className="ops-tile-state">{state === 'NOMINAL' ? '' : state}</span>
      </div>
      <div className="ops-tile-value">
        {value == null ? '—' : value}
        <span className="ops-tile-unit">{meta.unit}</span>
      </div>
      <Sparkline data={history} state={state} />
    </div>
  );
}

const SEV_RANK = { CRIT: 3, WARN: 2, CMD: 1, INFO: 0 };

export default function MissionOps() {
  const { packet, history } = useMissionTelemetry();
  const events = useEvents();
  const wide = typeof window === 'undefined' || window.innerWidth > 820;
  const [open, setOpen] = useState(wide);

  const mode = packet?.mode || 'IDLE';
  const comms = packet?.comms;
  const params = packet?.params || {};

  if (!open) {
    return (
      <button className="ops-reopen" onClick={() => setOpen(true)} title="Open Mission Ops">
        ▣ MISSION OPS
      </button>
    );
  }

  return (
    <section className="ops-console">
      <header className="ops-header">
        <div className="ops-id">
          <span className="ops-title">MISSION OPS</span>
          <span className="ops-craft">BHUVAN-1 · LANDER</span>
        </div>
        <div className="ops-clock">
          <span className="ops-clock-label">MET</span>
          <span className="ops-clock-val">{formatMET(packet?.t || 0)}</span>
        </div>
        <button className="ops-close" onClick={() => setOpen(false)} title="Hide">✕</button>
      </header>

      <div className="ops-statusbar">
        <span className={`ops-mode mode-${mode.toLowerCase()}`}>{mode}</span>
        <span className={`ops-link ${comms ? 'up' : 'down'}`}>
          <span className="ops-link-dot" />
          {comms ? 'DSN LOCK' : 'LOS — NO LINK'}
        </span>
        <span className="ops-sun">☀ {Math.round((packet?.sunElev || 0) * 90)}°</span>
      </div>

      <div className="ops-grid">
        {Object.keys(PARAM_META).map((k) => (
          <TelemetryTile key={k} tkey={k} value={params[k]} history={history[k]} />
        ))}
      </div>

      <div className="ops-cmd-label">COMMAND UPLINK</div>
      <div className="ops-cmd-row">
        {COMMANDS.map((c) => (
          <button
            key={c.id}
            className={`ops-cmd-btn ${c.danger ? 'danger' : ''} ${mode === c.mode ? 'active' : ''}`}
            onClick={() => missionControl.command(c)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="ops-cmd-label">EVENT LOG</div>
      <div className="ops-log">
        {events.length === 0 ? (
          <div className="ops-log-empty">awaiting telemetry…</div>
        ) : (
          events.slice(0, 30).map((e) => (
            <div key={e.id} className={`ops-log-row sev-${e.sev.toLowerCase()}`}>
              <span className="ops-log-t">{formatMET(e.t)}</span>
              <span className="ops-log-sev">{e.sev}</span>
              <span className="ops-log-msg">{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
