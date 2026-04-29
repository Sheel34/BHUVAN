import React, { useState, useEffect, useRef } from 'react';

const MISSION_LOG = [
  'BHUVAN LANDING SAFETY WORKBENCH v3.0',
  'BOOTING MODULE: terrain_ingest',
  'BOOTING MODULE: slope_roughness_shadow',
  'BOOTING MODULE: landing_zone_ranker',
  'BOOTING MODULE: 3d_inspection_surface',
  'BOOTING MODULE: descent_validation_sim',
  'INTERPRETABLE HAZARD ANALYSIS ........ ONLINE',
  'MISSION REPORTING .................... READY',
  '',
  'READY TO EVALUATE LANDING SAFETY.',
];

const STATS = [
  { label: 'ANALYSIS LAYERS', target: 6, suffix: '' },
  { label: 'ZONE CANDIDATES', target: 12, suffix: '' },
  { label: 'EVIDENCE PANELS', target: 4, suffix: '' },
  { label: 'DECISION MODES', target: 3, suffix: '' },
];

function AnimatedCounter({ target, suffix, duration = 2000, start }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    let startTime = null;
    const step = (ts) => {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.floor(eased * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [start, target, duration]);
  return <span>{value.toLocaleString()}{suffix}</span>;
}

function StarCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    const stars = [];
    for (let i = 0; i < 300; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.5 + 0.3,
        speed: Math.random() * 0.3 + 0.05,
        flicker: Math.random() * Math.PI * 2,
      });
    }
    // Shooting stars
    const shooters = [];
    let lastShooter = 0;

    let animId;
    const draw = (t) => {
      ctx.fillStyle = 'rgba(5, 3, 15, 0.15)';
      ctx.fillRect(0, 0, w, h);

      for (const s of stars) {
        s.flicker += 0.02;
        const alpha = 0.4 + Math.sin(s.flicker) * 0.3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200, 210, 255, ${alpha})`;
        ctx.fill();
        s.y += s.speed;
        if (s.y > h) { s.y = 0; s.x = Math.random() * w; }
      }

      // Shooting star
      if (t - lastShooter > 3000 + Math.random() * 5000) {
        lastShooter = t;
        shooters.push({
          x: Math.random() * w * 0.8, y: Math.random() * h * 0.3,
          vx: 4 + Math.random() * 3, vy: 2 + Math.random() * 2,
          life: 1, trail: [],
        });
      }
      for (let i = shooters.length - 1; i >= 0; i--) {
        const sh = shooters[i];
        sh.trail.push({ x: sh.x, y: sh.y });
        if (sh.trail.length > 20) sh.trail.shift();
        sh.x += sh.vx;
        sh.y += sh.vy;
        sh.life -= 0.015;

        for (let j = 0; j < sh.trail.length; j++) {
          const a = (j / sh.trail.length) * sh.life * 0.6;
          ctx.beginPath();
          ctx.arc(sh.trail[j].x, sh.trail[j].y, 1.2, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 200, 100, ${a})`;
          ctx.fill();
        }
        if (sh.life <= 0) shooters.splice(i, 1);
      }

      animId = requestAnimationFrame(draw);
    };
    animId = requestAnimationFrame(draw);

    const onResize = () => { w = canvas.width = window.innerWidth; h = canvas.height = window.innerHeight; };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', onResize); };
  }, []);

  return <canvas ref={canvasRef} className="intro-star-canvas" />;
}

function MarsOrb() {
  const orbRef = useRef(null);
  useEffect(() => {
    let angle = 0;
    const anim = () => {
      angle += 0.003;
      if (orbRef.current) {
        orbRef.current.style.backgroundPosition = `${angle * 50}px 0`;
      }
      requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
  }, []);

  return (
    <div className="mars-orb-container">
      <div className="mars-orb" ref={orbRef} />
      <div className="mars-orb-glow" />
      <div className="mars-orb-atmosphere" />
    </div>
  );
}

export default function IntroScreen({ onStart }) {
  const [lines, setLines] = useState([]);
  const [ready, setReady] = useState(false);
  const [statsReady, setStatsReady] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    let idx = 0;
    const timer = setInterval(() => {
      if (idx < MISSION_LOG.length) {
        setLines((prev) => [...prev, MISSION_LOG[idx]]);
        idx++;
      } else {
        clearInterval(timer);
        setTimeout(() => { setStatsReady(true); }, 300);
        setTimeout(() => { setReady(true); }, 800);
      }
    }, 200);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="intro-screen">
      <StarCanvas />
      <div className="intro-scanlines" />

      <div className="intro-content">
        {/* Left side: Title + Terminal */}
        <div className="intro-left">
          <div className="intro-header">
            <div className="intro-badge">
              <span className="badge-dot" />
              LANDING SAFETY // DECISION SUPPORT PROTOTYPE
            </div>
            <h1 className="intro-title">BHUVAN</h1>
            <p className="intro-subtitle">
              Terrain Risk Assessment and Landing Validation
            </p>
            <p className="intro-desc">
              Analyze orbital terrain, rank safe landing zones, inspect the evidence in 3D,
              then validate the recommendation through a descent simulation.
            </p>
          </div>

          <div className="intro-terminal">
            <div className="terminal-header">
              <span className="terminal-dot red" />
              <span className="terminal-dot yellow" />
              <span className="terminal-dot green" />
              <span className="terminal-title">BHUVAN://analysis_boot</span>
            </div>
            <div className="terminal-body">
              {lines.map((line, i) => (
                <div key={i} className="terminal-line">
                  {line && <span className="terminal-prompt">{'>'}</span>}
                  <span className={i === lines.length - 1 && !ready ? 'typing' : ''}>{line}</span>
                </div>
              ))}
              {!ready && <span className="terminal-cursor">█</span>}
            </div>
          </div>
        </div>

        <div className="intro-right">
          <MarsOrb />

          <div className="intro-stats-grid">
            {STATS.map((s, i) => (
              <div key={i} className="intro-stat-card">
                <div className="stat-value">
                  <AnimatedCounter target={s.target} suffix={s.suffix} start={statsReady} duration={1500 + i * 300} />
                </div>
                <div className="stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="intro-bottom">
        {ready && (
          <button
            className={`intro-launch-btn ${hovered ? 'hovered' : ''}`}
            onClick={onStart}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            id="launch-mission-btn"
          >
            <div className="btn-inner">
              <svg className="btn-hexagon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12,2 22,8.5 22,15.5 12,22 2,15.5 2,8.5" />
              </svg>
              OPEN ANALYSIS WORKBENCH
            </div>
            <span className="btn-glow" />
          </button>
        )}

        <div className="intro-features">
          {['Terrain ingestion', 'Explainable hazards', '3D inspection', 'Validation descent'].map((f, i) => (
            <div key={i} className="intro-feature" style={{ animationDelay: `${i * 0.15}s` }}>
              <span className="feature-dot" />
              {f}
            </div>
          ))}
        </div>
      </div>

      <div className="intro-footer">
        <span>BHUVAN v3.0.0</span>
        <span>MODE: ANALYSIS-FIRST</span>
        <span>MODEL: EXPLAINABLE RISK</span>
        <span>OUTPUT: LANDING DECISION SUPPORT</span>
      </div>
    </div>
  );
}
