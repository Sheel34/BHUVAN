import React, { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE, isLocalBackend } from '../lib/api';

const POLL_MS = 1000;
const remoteBackend = !isLocalBackend();

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

function SectionLabel({ children }) {
  return <div className="sysmon-section">{children}</div>;
}

/**
 * Live monitor: WebGL GPU + FPS from this laptop; CPU/RAM/GPU load from the
 * backend host (local NVML when API is localhost, cloud host stats when remote).
 */
export default function SystemMonitor({ clientGpu }) {
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [specs, setSpecs] = useState(null);
  const [stats, setStats] = useState(null);
  const [offline, setOffline] = useState(false);
  const [fps, setFps] = useState(0);
  const frames = useRef(0);

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

  const serverGpu = stats?.gpu;
  const showServerNvml = !remoteBackend && serverGpu;

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
          <SectionLabel>RENDER · THIS DEVICE</SectionLabel>
          {clientGpu ? (
            <>
              <div className="sysmon-specline" title={clientGpu.vendor || undefined}>
                {clientGpu.renderer}
              </div>
              {clientGpu.software ? (
                <div className="sysmon-row sysmon-nogpu sysmon-warn">
                  SOFTWARE WEBGL — ENABLE DISCRETE GPU IN WINDOWS GRAPHICS SETTINGS
                </div>
              ) : (
                <div className="sysmon-row sysmon-nogpu">
                  WEBGL {clientGpu.webgl2 ? '2' : '1'} · HARDWARE ACCELERATED
                </div>
              )}
            </>
          ) : (
            <div className="sysmon-row sysmon-nogpu">INITIALIZING GPU…</div>
          )}

          {showServerNvml ? (
            <>
              <SectionLabel>HOST · NVML</SectionLabel>
              <Bar label="GPU" value={serverGpu.util_percent} detail="load" />
              <Bar
                label="VRAM"
                value={serverGpu.vram_percent != null ? Math.round(serverGpu.vram_percent) : null}
                detail={`${serverGpu.vram_used_gb}/${serverGpu.vram_total_gb} GB`}
              />
              <div className="sysmon-row sysmon-inline">
                <span>
                  <span className="sysmon-label">TEMP </span>
                  <span className="sysmon-value" style={{ color: loadColor(serverGpu.temp_c) }}>
                    {serverGpu.temp_c}°C
                  </span>
                </span>
                <span>
                  <span className="sysmon-label">PWR </span>
                  <span className="sysmon-value">
                    {serverGpu.power_w != null ? `${serverGpu.power_w}W` : '—'}
                    {serverGpu.power_limit_w != null && (
                      <span className="sysmon-detail">/{Math.round(serverGpu.power_limit_w)}W</span>
                    )}
                  </span>
                </span>
              </div>
              {specs?.gpu && (
                <div className="sysmon-specline" title={`Driver ${specs.gpu.driver}`}>
                  {specs.gpu.name}
                </div>
              )}
            </>
          ) : remoteBackend ? (
            <div className="sysmon-row sysmon-nogpu">
              GPU LOAD/VRAM NEED LOCAL BACKEND — 3D RENDER USES YOUR GPU ABOVE
            </div>
          ) : (
            <div className="sysmon-row sysmon-nogpu">
              {offline ? 'BACKEND OFFLINE' : 'NO NVIDIA GPU ON BACKEND HOST'}
            </div>
          )}

          <SectionLabel>{remoteBackend ? 'BACKEND · CLOUD' : 'HOST · CPU/RAM'}</SectionLabel>
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
        </div>
      )}
    </aside>
  );
}
