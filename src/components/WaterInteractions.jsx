import { useEffect } from 'react';
import { pressWater, releaseWater, waterPressure, waterSettled, forgetWater } from '../engine/waterFeedback';

export default function WaterInteractions() {
  useEffect(() => {
    const root = document.querySelector('.simulation-root');
    if (!root) return;
    const abort = new AbortController(), active = new Set(), recent = new WeakMap(), waveTimers = new Map();
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const target = event => {
      const button = event.target.closest?.('button,input[type="number"],select');
      return button && root.contains(button) && !button.disabled && !button.matches('.hud-drawer-backdrop') ? button : null;
    };
    const scan = () => root.querySelectorAll('button:not(.hud-drawer-backdrop),input[type="number"],select').forEach(button => {
      button.classList.add('water-button');
      if(!button.hasAttribute('data-liquid-control'))button.dataset.liquidControl='native-control';
    });
    const tick = now => {
      frame = 0;
      active.forEach(button => {
        if (!button.isConnected || waterSettled(button, now, motion.matches)) {
          button.style.removeProperty('--water-pressure');
          button.removeAttribute('data-water-state');
          forgetWater(button); active.delete(button); return;
        }
        button.style.setProperty('--water-pressure', waterPressure(button, now, motion.matches));
      });
      if (active.size) frame = requestAnimationFrame(tick);
    };
    const down = button => {
      const now = performance.now();
      pressWater(button, now); recent.set(button, now); active.add(button);
      button.style.setProperty('--water-pressure', motion.matches ? 1 : 0);
      button.dataset.waterState = 'down';
      clearTimeout(waveTimers.get(button));
      button.removeAttribute('data-water-wave');
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const up = button => {
      if (!active.has(button) || button.dataset.waterState !== 'down') return;
      releaseWater(button, performance.now()); button.dataset.waterState = 'returning';
      button.dataset.waterWave = 'release';
      waveTimers.set(button, setTimeout(() => { button.removeAttribute('data-water-wave'); waveTimers.delete(button); }, 600));
    };
    const options = { signal: abort.signal, capture: true };
    root.addEventListener('pointerdown', event => { const button = target(event); if (button && event.button === 0) down(button); }, options);
    window.addEventListener('pointerup', () => active.forEach(up), options);
    window.addEventListener('pointercancel', () => active.forEach(up), options);
    window.addEventListener('blur', () => active.forEach(up), options);
    root.addEventListener('focusout', event => { const button = target(event); if (button) up(button); }, options);
    root.addEventListener('keydown', event => {
      const button = target(event);
      if (button && !event.repeat && [' ', 'Enter'].includes(event.key)) down(button);
    }, options);
    root.addEventListener('keyup', event => { const button = target(event); if (button && [' ', 'Enter'].includes(event.key)) up(button); }, options);
    root.addEventListener('click', event => {
      const button = target(event);
      if (button && (!recent.has(button) || performance.now() - recent.get(button) > 500) && !active.has(button)) { down(button); up(button); }
    }, options);
    const observer = new MutationObserver(scan); observer.observe(root, { childList: true, subtree: true }); scan();
    return () => {
      abort.abort(); observer.disconnect(); cancelAnimationFrame(frame);
      active.forEach(button => { forgetWater(button); button.style.removeProperty('--water-pressure'); button.removeAttribute('data-water-state'); });
      waveTimers.forEach((timer, button) => { clearTimeout(timer); button.removeAttribute('data-water-wave'); });
      root.querySelectorAll('.water-button').forEach(button => button.classList.remove('water-button'));
    };
  }, []);
  return null;
}
