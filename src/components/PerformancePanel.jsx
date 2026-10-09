import { useEffect, useState } from 'react';
import { API_BASE, isLocalBackend } from '../lib/api';
const number=(v,suffix='')=>Number.isFinite(v)?v.toFixed(1)+suffix:'Unavailable';
export default function PerformancePanel({gpu,stats,onClose}) {
  const [host,setHost]=useState(null),[specs,setSpecs]=useState(null),[failed,setFailed]=useState(false);
  useEffect(()=> {
    const controller=new AbortController();let timer;
    fetch(`${API_BASE}/api/v1/system/specs`,{signal:controller.signal}).then(r=>r.ok?r.json():null).then(setSpecs).catch(()=>{});
    const poll=async()=>{try{const r=await fetch(`${API_BASE}/api/v1/system/stats`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(4000)])});if(!r.ok)throw Error();const value=await r.json();if(!controller.signal.aborted){setHost(value);setFailed(false);}}catch{if(!controller.signal.aborted)setFailed(true);}finally{if(!controller.signal.aborted)timer=setTimeout(poll,2000);}};
    poll();return()=>{controller.abort();clearTimeout(timer);};
  },[]);
  const local=isLocalBackend();
  return <section className="performance-panel" aria-label="Live performance">
    <div className="hud-panel-header">LIVE PERFORMANCE<button onClick={onClose} aria-label="Close performance">×</button></div>
    <div className="hud-section-label">THIS DEVICE · 3D RENDERING</div>
    <p className="gpu-readout">{gpu?.renderer||'Renderer not yet available'}</p>
    <dl className="dataset-details"><dt>Scene frame rate</dt><dd>{number(stats?.fps,' FPS')}</dd><dt>Frame interval</dt><dd>{number(stats?.frameMs,' ms')}</dd><dt>JavaScript heap</dt><dd>{number(stats?.browserHeapBytes==null?null:stats.browserHeapBytes/2**20,' MiB')}</dd><dt>Draw calls / triangles</dt><dd>{stats?.drawCalls??'—'} / {stats?.renderedTriangles?.toLocaleString()??'—'}</dd></dl>
    <p className="assumption">Frames sampled from the active 3D renderer against wall-clock time. The frame cap affects FPS. Heap is JavaScript memory, not total browser RAM or VRAM. Rendering happens on your device, including after deployment.</p>
    <div className="hud-section-label">{local?'LOCAL API HOST · WHOLE MACHINE':'REMOTE API HOST · SERVER'}</div>
    {failed?<p role="status">Hardware telemetry unavailable.</p>:<dl className="dataset-details"><dt>Host RAM</dt><dd>{number(host?.ram_used_gb,' GiB')} / {number(host?.ram_total_gb,' GiB')}</dd><dt>Host CPU</dt><dd>{number(host?.cpu_percent,'%')}</dd><dt>API process RAM</dt><dd>{number(host?.process_rss_mib,' MiB')}</dd><dt>NVIDIA device</dt><dd>{specs?.gpu?.name||'Unavailable'}</dd><dt>Device GPU load</dt><dd>{number(host?.gpu?.util_percent,'%')}</dd><dt>Device VRAM</dt><dd>{number(host?.gpu?.vram_used_gb,' GiB')} / {number(host?.gpu?.vram_total_gb,' GiB')}</dd></dl>}
    <p className="assumption">{local?'Driver GPU readings include all applications and may describe a different adapter from the active WebGL renderer above.':'Server readings do not describe your laptop. Browsers do not expose your total GPU utilization or VRAM usage.'} Host RAM may reflect the host rather than a container's quota.</p>
  </section>;
}
