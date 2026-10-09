const overlaps = (a, b, gap) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
  && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Keep compact targets on their measured anchors; nudge only colliding targets.
export function layoutTerrainMarkers(points, bounds, size = 32, obstacles = []) {
  const placed = [];
  if (bounds.right - bounds.left < size || bounds.bottom - bounds.top < size) return placed;
  for (const point of points) {
    if (!point.visible) continue;
    const candidates = [{ x: point.x - size / 2, y: point.y - size / 2 }];
    for (let ring = 1; ring <= 3; ring++) for (let k = 0; k < 8; k++) {
      const angle = k * Math.PI / 4, radius = ring * (size + 4);
      candidates.push({ x: point.x - size / 2 + Math.cos(angle) * radius,
        y: point.y - size / 2 + Math.sin(angle) * radius });
    }
    for (const candidate of candidates) {
      const rect = { id: point.id, x: clamp(candidate.x, bounds.left, bounds.right - size),
        y: clamp(candidate.y, bounds.top, bounds.bottom - size), width: size, height: size,
        anchorX: point.x, anchorY: point.y };
      if (placed.some(other => overlaps(rect, other, 4)) || obstacles.some(other => overlaps(rect, other, 4))) continue;
      placed.push(rect); break;
    }
  }
  return placed;
}
