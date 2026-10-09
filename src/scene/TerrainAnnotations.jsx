import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { sampleHeight } from '../engine/terrain';
import { layoutTerrainMarkers } from '../engine/annotationLayout';

export function AnnotationProjection({ points, terrain, verticalExaggeration, registry, enabled }) {
  const { camera, size, scene, gl } = useThree();
  const state = useMemo(() => ({ world: new THREE.Vector3(), projected: new THREE.Vector3(), origin: new THREE.Vector3(),
    direction: new THREE.Vector3(), ray: new THREE.Raycaster(), hits: [], meshes: [], last: 0, occlusionAt: 0, occluded: new Map() }), []);
  const anchors = useMemo(() => points.map(poi => ({ id: poi.id, x: poi.x, z: poi.z,
    y: Number.isFinite(poi.elevation_m) ? poi.elevation_m - (terrain.elevationOrigin || 0) : sampleHeight(terrain, poi.x, poi.z) })), [points, terrain]);
  useEffect(() => () => registry.current.forEach(item => { if (item.button) item.button.hidden = true; }), [registry]);
  useFrame(({ clock }) => {
    const now = clock.elapsedTime;
    if (now - state.last < .045) return;
    state.last = now;
    const root = gl.domElement.closest('.simulation-root');
    const blocked = !enabled || Boolean(root?.querySelector('.hud-overlay.panel-open'));
    const checkOcclusion = now - state.occlusionAt > .25;
    if (checkOcclusion && !blocked) {
      state.occlusionAt = now; state.meshes.length = 0;
      scene.traverse(object => { if (object.isMesh && object.visible && object.geometry?.userData.tileId) state.meshes.push(object); });
      camera.getWorldPosition(state.origin);
    }
    const projected = anchors.map(anchor => {
      state.world.set(anchor.x, anchor.y * verticalExaggeration + terrain.scale * .006, anchor.z);
      state.projected.copy(state.world).project(camera);
      let visible = !blocked && state.projected.z >= -1 && state.projected.z <= 1
        && Math.abs(state.projected.x) <= 1 && Math.abs(state.projected.y) <= 1;
      if (checkOcclusion && visible) {
        const distance = state.origin.distanceTo(state.world);
        state.direction.copy(state.world).sub(state.origin).normalize();
        state.ray.set(state.origin, state.direction); state.ray.far = Math.max(0, distance - terrain.scale * .004);
        state.hits.length = 0; state.ray.intersectObjects(state.meshes, false, state.hits);
        state.occluded.set(anchor.id, state.hits.length > 0);
      }
      visible = visible && !state.occluded.get(anchor.id);
      return { id: anchor.id, x: (state.projected.x + 1) * size.width / 2, y: (1 - state.projected.y) * size.height / 2, visible };
    });
    const compact = size.width <= 820;
    const markerSize = compact ? 44 : 32;
    const bounds = { left: 14, right: size.width - 14, top: compact ? 176 : 92, bottom: size.height - (compact ? 182 : 150) };
    const obstacles = compact ? [{ x: 18, y: 176, width: Math.min(size.width - 36, 370), height: 94 }]
      : [{ x: 20, y: 118, width: 390, height: 132 }, { x: 34, y: size.height - 394, width: 236, height: 226 }];
    const laidOut = layoutTerrainMarkers(projected, bounds, markerSize, obstacles);
    const byId = new Map(laidOut.map(rect => [rect.id, rect]));
    registry.current.forEach((item, id) => {
      const rect = byId.get(id), show = Boolean(rect);
      if (!item.button || !item.leader || !item.dot) return;
      item.button.hidden = !show;
      item.leader.style.display = item.dot.style.display = show ? '' : 'none';
      if (!rect) return;
      item.button.style.left = `${rect.x}px`; item.button.style.top = `${rect.y}px`;
      const tipOnLeft = rect.x + 226 > size.width - 14;
      item.button.style.setProperty('--tooltip-left', tipOnLeft ? 'auto' : `${Math.max(12 - rect.x, -12)}px`);
      item.button.style.setProperty('--tooltip-right', tipOnLeft ? '0px' : 'auto');
      item.button.style.setProperty('--tooltip-top', rect.y + markerSize + 65 > size.height - 145 ? '-67px' : `${markerSize + 5}px`);
      const x2 = rect.x + markerSize / 2, y2 = rect.y + markerSize / 2;
      const moved = Math.hypot(x2 - rect.anchorX, y2 - rect.anchorY) > markerSize / 2;
      item.leader.style.display = item.dot.style.display = moved ? '' : 'none';
      item.leader.setAttribute('x1', rect.anchorX); item.leader.setAttribute('y1', rect.anchorY);
      item.leader.setAttribute('x2', x2); item.leader.setAttribute('y2', y2);
      item.dot.setAttribute('cx', rect.anchorX); item.dot.setAttribute('cy', rect.anchorY);
    });
  });
  return null;
}

export default function TerrainAnnotations({ points, metric, registry, onSelect, selected }) {
  const ref = (id, key, element) => {
    const item = registry.current.get(id) || {};
    item[key] = element; registry.current.set(id, item);
  };
  useEffect(() => {
    const ids = new Set(points.map(poi => poi.id));
    registry.current.forEach((_, id) => { if (!ids.has(id)) registry.current.delete(id); });
  }, [points, registry]);
  return <div className="terrain-annotations" aria-label="Heuristic terrain points">
    <svg aria-hidden="true" className="terrain-annotation-leaders">{points.map(poi => <g key={poi.id}>
      <line ref={node => ref(poi.id, 'leader', node)} style={{ display: 'none' }} />
      <circle r="4" ref={node => ref(poi.id, 'dot', node)} style={{ display: 'none' }} />
    </g>)}</svg>
    {points.map((poi, index) => <button key={poi.id} hidden className="terrain-annotation"
      ref={node => ref(poi.id, 'button', node)} onClick={() => onSelect(poi)}
      onPointerLeave={event => event.currentTarget.removeAttribute('data-tooltip-dismissed')}
      onFocus={event => event.currentTarget.removeAttribute('data-tooltip-dismissed')}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation(); event.currentTarget.dataset.tooltipDismissed = 'true';
        document.querySelector('[data-liquid-control="frame-all"]')?.focus({ preventScroll: true });
      }}
      aria-label={`Inspect point ${index + 1}: ${poi.kind}`} aria-pressed={selected === poi.id}>
      <span className="terrain-annotation-number">{String(index + 1).padStart(2, '0')}</span>
      <span className="terrain-annotation-copy" aria-hidden="true"><strong>{String(index + 1).padStart(2, '0')} · {poi.kind.replaceAll('_', ' ')}</strong>
        <small>Heuristic · {Number.isFinite(poi.elevation_m) ? `${poi.elevation_m.toFixed(metric ? 0 : 3)} ${metric ? 'm' : 'rel'}` : 'inspect evidence'}</small></span>
    </button>)}
  </div>;
}
