import React, { useEffect, useRef, useState, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000';
const POLL_MS = 1000;

// Calm by default — steel for normal load, warm only when genuinely high.
function loadColor(pct) {
  if (pct == null) return 'var(--text-dim)';
  if (pct < 65) return '#93a4c4';
  if (pct < 85) return 'var(--accent-orange)';
  return 'var(--accent-red)';
}

function Bar({ label, value, max = 100, unit = '%', detail }) {
  const pct = value == null ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="sysmon-row">
      <div className="sysmon-row-head">
        <span className="sysmon-label">{label}</span>
        <span className="sysmon-value" style={{ color: loadColor(pct) }}>
          {value == null ? '—' : `${value}${unit}`}
          {detail && <span className="sysmon-detail"> {detail}</span>}
        </span>
      </div>
      <div className="sysmon-track">
        <div
          className="sysmon-fill"
          style={{ width: `${pct}%`, background: loadColor(pct) }}
        />
      </div>
    </div>
  );
}

/**
 * Live hardware monitor: real CPU/RAM via psutil, real GPU load, VRAM,
 * temperature, and power via NVIDIA NVML, plus render FPS measured on
 * this page. Collapsible to a tiny pill; fully closeable.
 */
export default function SystemMonitor() {
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [specs, setSpecs] = useState(null);
  const [stats, setStats] = useState(null);
  const [offline, setOffline] = useState(false);
  const [fps, setFps] = useState(0);
  const frames = useRef(0);

  // Real frame counter — counts rAF ticks on this page
  useEffect(() => {
    let raf;
    let last = performance.now();
    const tick = (now) => {
      frames.current += 1;
      if (now - last >= 1000) {
        setFps(Math.round((frames.current * 1000) / (now - last)));
        frames.current = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;

    fetch(`${API_BASE}/api/v1/system/specs`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((s) => { if (active) setSpecs(s); })
      .catch(() => {});

    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/v1/system/stats`, {
          signal: AbortSignal.timeout(3000),
        });
        const s = await r.json();
        if (active) {
          setStats(s);
          setOffline(false);
        }
      } catch {
        if (active) setOffline(true);
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);

  const reopen = useCallback(() => setOpen(true), []);

  if (!open) {
    return (
      <button className="sysmon-reopen" onClick={reopen} title="Show system monitor">
        ⊙ SYS
      </button>
    );
  }

  const gpu = stats?.gpu;

  return (
    <aside className={`sysmon ${collapsed ? 'collapsed' : ''}`}>
      <header className="sysmon-header">
        <span className="sysmon-title">
          SYSTEM
          {offline && <span className="sysmon-offline"> · OFFLINE</span>}
        </span>
        <span className="sysmon-fps">{fps} FPS</span>
        <div className="sysmon-controls">
          <button onClick={() => setCollapsed((c) => !c)} title={collapsed ? 'Expand' : 'Collapse'}>
            {collapsed ? '▸' : '▾'}
          </button>
          <button onClick={() => setOpen(false)} title="Close monitor">✕</button>
        </div>
      </header>

      {!collapsed && (
        <div className="sysmon-body">
          <Bar
            label="CPU"
            value={stats?.cpu_percent != null ? Math.round(stats.cpu_percent) : null}
            detail={specs ? `${specs.cpu_threads}T` : ''}
          />
          <Bar
            label="RAM"
            value={stats?.ram_percent != null ? Math.round(stats.ram_percent) : null}
            detail={stats ? `${stats.ram_used_gb}/${stats.ram_total_gb} GB` : ''}
          />
          {gpu ? (
            <>
              <Bar label="GPU" value={gpu.util_percent} detail="RTX load" />
              <Bar
                label="VRAM"
                value={gpu.vram_percent != null ? Math.round(gpu.vram_percent) : null}
                detail={`${gpu.vram_used_gb}/${gpu.vram_total_gb} GB`}
              />
              <div className="sysmon-row sysmon-inline">
                <span>
                  <span className="sysmon-label">TEMP </span>
                  <span className="sysmon-value" style={{ color: loadColor(gpu.temp_c) }}>
                    {gpu.temp_c}°C
                  </span>
                </span>
                <span>
                  <span className="sysmon-label">PWR </span>
                  <span className="sysmon-value">
                    {gpu.power_w != null ? `${gpu.power_w}W` : '—'}
                    {gpu.power_limit_w != null && (
                      <span className="sysmon-detail">/{Math.round(gpu.power_limit_w)}W</span>
                    )}
                  </span>
                </span>
              </div>
            </>
          ) : (
            <div className="sysmon-row sysmon-nogpu">
              {offline ? 'BACKEND OFFLINE — GPU TELEMETRY UNAVAILABLE' : 'NO NVIDIA GPU DETECTED'}
            </div>
          )}
          {specs?.gpu && (
            <div className="sysmon-specline" title={`Driver ${specs.gpu.driver}`}>
              {specs.gpu.name}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
