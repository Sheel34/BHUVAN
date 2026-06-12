import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { analysisColor } from '../engine/terrain';

const MIN_TILE_CELLS = 32;
const TARGET_TILE_VERTS = 65;
const REFINE_DISTANCE_FACTOR = 2.2;
const MAX_VISIBLE_TILES = 160;
const MAX_CACHED_GEOMETRIES = 384;
const CAMERA_UPDATE_INTERVAL = 6;
const CAMERA_MOVE_EPSILON = 4;
const LOD_LEVELS = [
  { level: 0, targetVerts: TARGET_TILE_VERTS },
  { level: 1, targetVerts: TARGET_TILE_VERTS },
  { level: 2, targetVerts: TARGET_TILE_VERTS },
];

function indexToWorld(index, size, scale) {
  return (index / (size - 1) - 0.5) * scale;
}

function makeRange(start, end, step) {
  const result = [];
  for (let value = start; value < end; value += step) {
    result.push(value);
  }
  if (result[result.length - 1] !== end) {
    result.push(end);
  }
  return result;
}

function getLayerValue(terrain, layers, viewMode, dataIndex, height) {
  if (viewMode === 'elevation') {
    return (height - terrain.minH) / (terrain.maxH - terrain.minH + 0.001);
  }
  return layers?.[viewMode]?.[dataIndex] ?? 0;
}

function terrainNormal(terrain, i, j) {
  const { data, size, scale } = terrain;
  const i0 = Math.max(0, i - 1);
  const i1 = Math.min(size - 1, i + 1);
  const j0 = Math.max(0, j - 1);
  const j1 = Math.min(size - 1, j + 1);
  const cell = scale / (size - 1);
  const dx = Math.max(1, i1 - i0) * cell;
  const dz = Math.max(1, j1 - j0) * cell;
  const dhdx = (data[i1 * size + j] - data[i0 * size + j]) / dx;
  const dhdz = (data[i * size + j1] - data[i * size + j0]) / dz;
  const length = Math.sqrt(dhdx * dhdx + dhdz * dhdz + 1);
  return [-dhdx / length, 1 / length, -dhdz / length];
}

function skirtNormal(edge) {
  if (edge === 'west') return [-1, 0, 0];
  if (edge === 'east') return [1, 0, 0];
  if (edge === 'north') return [0, 0, -1];
  return [0, 0, 1];
}

function addSkirtToGeometry({ positions, normals, indices, topIndices, edge, skirtDepth }) {
  const skirtStart = positions.length / 3;
  const [nx, ny, nz] = skirtNormal(edge);

  for (const topIndex of topIndices) {
    const p = topIndex * 3;
    positions.push(positions[p], positions[p + 1] - skirtDepth, positions[p + 2]);
    normals.push(nx, ny, nz);
  }

  for (let n = 0; n < topIndices.length - 1; n++) {
    const t0 = topIndices[n];
    const t1 = topIndices[n + 1];
    const b0 = skirtStart + n;
    const b1 = skirtStart + n + 1;

    if (edge === 'west') {
      indices.push(t0, b0, t1, t1, b0, b1);
    } else if (edge === 'east') {
      indices.push(t0, t1, b0, t1, b1, b0);
    } else if (edge === 'north') {
      indices.push(t0, t1, b0, t1, b1, b0);
    } else {
      indices.push(t0, b0, t1, t1, b0, b1);
    }
  }
}

function buildBaseGeometry(terrain, tile) {
  const { data, size, scale, minH, maxH } = terrain;
  const iRange = makeRange(tile.i0, tile.i1, tile.step);
  const jRange = makeRange(tile.j0, tile.j1, tile.step);
  const rows = iRange.length;
  const cols = jRange.length;
  const positions = [];
  const normals = [];
  const indices = [];

  for (let i = 0; i < rows; i++) {
    const dataI = iRange[i];
    const wx = indexToWorld(dataI, size, scale);
    for (let j = 0; j < cols; j++) {
      const dataJ = jRange[j];
      const wz = indexToWorld(dataJ, size, scale);
      const dataIndex = dataI * size + dataJ;
      const height = data[dataIndex];
      const [nx, ny, nz] = terrainNormal(terrain, dataI, dataJ);
      positions.push(wx, height, wz);
      normals.push(nx, ny, nz);
    }
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = (i + 1) * cols + j;
      const c = i * cols + j + 1;
      const d = (i + 1) * cols + j + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const skirtDepth = Math.max(1.5, (maxH - minH) * 0.08);
  const west = [];
  const east = [];
  for (let j = 0; j < cols; j++) {
    west.push(j);
    east.push((rows - 1) * cols + j);
  }
  const north = [];
  const south = [];
  for (let i = 0; i < rows; i++) {
    north.push(i * cols);
    south.push(i * cols + cols - 1);
  }

  if (tile.skirts?.west) {
    addSkirtToGeometry({ positions, normals, indices, topIndices: west, edge: 'west', skirtDepth });
  }
  if (tile.skirts?.east) {
    addSkirtToGeometry({ positions, normals, indices, topIndices: east, edge: 'east', skirtDepth });
  }
  if (tile.skirts?.north) {
    addSkirtToGeometry({ positions, normals, indices, topIndices: north, edge: 'north', skirtDepth });
  }
  if (tile.skirts?.south) {
    addSkirtToGeometry({ positions, normals, indices, topIndices: south, edge: 'south', skirtDepth });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData = {
    terrainTile: tile.key,
    step: tile.step,
    cells: Math.max(tile.i1 - tile.i0, tile.j1 - tile.j0),
  };
  return geometry;
}

function buildTileColorAttribute(terrain, layers, viewMode, tile) {
  const { data, size } = terrain;
  const iRange = makeRange(tile.i0, tile.i1, tile.step);
  const jRange = makeRange(tile.j0, tile.j1, tile.step);
  const rows = iRange.length;
  const cols = jRange.length;
  const colors = [];

  for (let i = 0; i < rows; i++) {
    const dataI = iRange[i];
    for (let j = 0; j < cols; j++) {
      const dataJ = jRange[j];
      const dataIndex = dataI * size + dataJ;
      const height = data[dataIndex];
      const layerValue = getLayerValue(terrain, layers, viewMode, dataIndex, height);
      const [r, g, b] = analysisColor(viewMode, layerValue, terrain, height);
      colors.push(r, g, b);
    }
  }

  if (tile.skirts?.west) {
    for (let j = 0; j < cols; j++) {
      const idx = j * 3;
      colors.push(colors[idx], colors[idx + 1], colors[idx + 2]);
    }
  }
  if (tile.skirts?.east) {
    for (let j = 0; j < cols; j++) {
      const idx = ((rows - 1) * cols + j) * 3;
      colors.push(colors[idx], colors[idx + 1], colors[idx + 2]);
    }
  }
  if (tile.skirts?.north) {
    for (let i = 0; i < rows; i++) {
      const idx = (i * cols) * 3;
      colors.push(colors[idx], colors[idx + 1], colors[idx + 2]);
    }
  }
  if (tile.skirts?.south) {
    for (let i = 0; i < rows; i++) {
      const idx = (i * cols + cols - 1) * 3;
      colors.push(colors[idx], colors[idx + 1], colors[idx + 2]);
    }
  }

  const attr = new THREE.BufferAttribute(new Float32Array(colors), 3);
  return attr;
}

function makeTile(terrain, i0, i1, j0, j1, depth) {
  const { size, scale, minH, maxH } = terrain;
  const x0 = indexToWorld(i0, size, scale);
  const x1 = indexToWorld(i1, size, scale);
  const z0 = indexToWorld(j0, size, scale);
  const z1 = indexToWorld(j1, size, scale);
  const cells = Math.max(i1 - i0, j1 - j0);
  const step = Math.max(1, Math.ceil(cells / (TARGET_TILE_VERTS - 1)));
  const centerX = (x0 + x1) * 0.5;
  const centerZ = (z0 + z1) * 0.5;
  const centerY = (minH + maxH) * 0.5;
  const radius = Math.sqrt((x1 - x0) ** 2 + (z1 - z0) ** 2 + (maxH - minH) ** 2) * 0.5 + 4;

  return {
    key: `${i0}:${i1}:${j0}:${j1}:${step}:${depth}`,
    i0, i1, j0, j1, step, depth, cells,
    centerX, centerZ,
    extent: Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)),
    sphere: new THREE.Sphere(new THREE.Vector3(centerX, centerY, centerZ), radius),
  };
}

function isCameraNearTile(tile, cameraPosition) {
  const dx = tile.centerX - cameraPosition.x;
  const dz = tile.centerZ - cameraPosition.z;
  const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
  const altitudeBias = Math.max(0, cameraPosition.y) * 0.35;
  return horizontalDistance + altitudeBias < tile.extent * REFINE_DISTANCE_FACTOR;
}

function splitNode(tile) {
  const iMid = Math.floor((tile.i0 + tile.i1) * 0.5);
  const jMid = Math.floor((tile.j0 + tile.j1) * 0.5);
  if (iMid <= tile.i0 || iMid >= tile.i1 || jMid <= tile.j0 || jMid >= tile.j1) {
    return [];
  }
  return [
    [tile.i0, iMid, tile.j0, jMid],
    [iMid, tile.i1, tile.j0, jMid],
    [tile.i0, iMid, jMid, tile.j1],
    [iMid, tile.i1, jMid, tile.j1],
  ];
}

function selectVisibleTiles(terrain, camera) {
  const frustum = new THREE.Frustum();
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(matrix);

  const selected = [];
  const visit = (i0, i1, j0, j1, depth) => {
    if (selected.length >= MAX_VISIBLE_TILES) return;

    const tile = makeTile(terrain, i0, i1, j0, j1, depth);
    if (!frustum.intersectsSphere(tile.sphere)) return;

    const canSplit = tile.cells > MIN_TILE_CELLS;
    if (canSplit && isCameraNearTile(tile, camera.position)) {
      const children = splitNode(tile);
      if (children.length > 0) {
        for (const child of children) {
          visit(child[0], child[1], child[2], child[3], depth + 1);
        }
        return;
      }
    }

    selected.push(tile);
  };

  visit(0, terrain.size - 1, 0, terrain.size - 1, 0);
  selected.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  return selected;
}

function disposeGeometryCache(cache) {
  for (const geometry of cache.values()) {
    geometry.dispose();
  }
  cache.clear();
}

function disposeColorCache(cache) {
  cache.clear();
}

function trimCache(cache, visibleKeys) {
  if (cache.size <= MAX_CACHED_GEOMETRIES) return;
  for (const [key, value] of cache) {
    if (cache.size <= MAX_CACHED_GEOMETRIES) return;
    if (visibleKeys.has(key)) continue;
    if (value.dispose) value.dispose();
    cache.delete(key);
  }
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function edgeNeighbors(tile, allTiles, edge) {
  return allTiles.filter((candidate) => {
    if (candidate === tile) return false;
    if (edge === 'west') {
      return candidate.i1 === tile.i0 && overlaps(candidate.j0, candidate.j1, tile.j0, tile.j1);
    }
    if (edge === 'east') {
      return candidate.i0 === tile.i1 && overlaps(candidate.j0, candidate.j1, tile.j0, tile.j1);
    }
    if (edge === 'north') {
      return candidate.j1 === tile.j0 && overlaps(candidate.i0, candidate.i1, tile.i0, tile.i1);
    }
    return candidate.j0 === tile.j1 && overlaps(candidate.i0, candidate.i1, tile.i0, tile.i1);
  });
}

function edgeNeedsSkirt(tile, allTiles, edge) {
  const neighbors = edgeNeighbors(tile, allTiles, edge);
  if (neighbors.length === 0) return true;
  return neighbors.some((neighbor) => neighbor.step !== tile.step);
}

function withSkirtFlags(tile, allTiles) {
  const skirts = {
    west: edgeNeedsSkirt(tile, allTiles, 'west'),
    east: edgeNeedsSkirt(tile, allTiles, 'east'),
    north: edgeNeedsSkirt(tile, allTiles, 'north'),
    south: edgeNeedsSkirt(tile, allTiles, 'south'),
  };
  const skirtKey = `${skirts.west ? 'w' : '-'}${skirts.east ? 'e' : '-'}${skirts.north ? 'n' : '-'}${skirts.south ? 's' : '-'}`;
  return { ...tile, skirts, skirtKey };
}

function TerrainTile({ geometry, material }) {
  return (
    <mesh geometry={geometry} material={material} receiveShadow frustumCulled />
  );
}

export default React.memo(function TerrainChunked({ terrain, layers, viewMode }) {
  const { camera } = useThree();
  const geometryCacheRef = useRef(new Map());
  const colorCacheRef = useRef(new Map());
  const lastCameraPositionRef = useRef(new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0));
  const frameRef = useRef(0);
  const prevViewModeRef = useRef(null);
  const [visibleTiles, setVisibleTiles] = useState(() => selectVisibleTiles(terrain, camera));

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.05,
        flatShading: false,
      }),
    [],
  );

  const updateVisibleTiles = useCallback(
    (force = false) => {
      frameRef.current += 1;
      if (!force && frameRef.current % CAMERA_UPDATE_INTERVAL !== 0) return;

      const previous = lastCameraPositionRef.current;
      const moved = previous.distanceTo(camera.position);
      if (!force && moved < CAMERA_MOVE_EPSILON) return;

      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      const nextTiles = selectVisibleTiles(terrain, camera);
      const signature = nextTiles.map((tile) => tile.key).join('|');

      setVisibleTiles((current) => {
        const currentSignature = current.map((tile) => tile.key).join('|');
        return currentSignature === signature ? current : nextTiles;
      });
      previous.copy(camera.position);
    },
    [camera, terrain],
  );

  useEffect(() => {
    disposeGeometryCache(geometryCacheRef.current);
    disposeColorCache(colorCacheRef.current);
    lastCameraPositionRef.current.set(Number.POSITIVE_INFINITY, 0, 0);
    updateVisibleTiles(true);
  }, [layers, terrain, updateVisibleTiles]);

  useEffect(() => {
    return () => {
      disposeGeometryCache(geometryCacheRef.current);
      disposeColorCache(colorCacheRef.current);
    };
  }, []);

  useFrame(() => {
    updateVisibleTiles(false);
  });

  const renderedTiles = useMemo(() => {
    if (prevViewModeRef.current !== null && prevViewModeRef.current !== viewMode) {
      const prefix = `${prevViewModeRef.current}:`;
      const colCache = colorCacheRef.current;
      for (const key of colCache.keys()) {
        if (key.startsWith(prefix)) {
          colCache.delete(key);
        }
      }
    }
    prevViewModeRef.current = viewMode;

    const geoCache = geometryCacheRef.current;
    const colCache = colorCacheRef.current;
    const geoVisibleKeys = new Set();
    const colVisibleKeys = new Set();
    const tilesWithSkirts = visibleTiles.map((tile) => withSkirtFlags(tile, visibleTiles));

    const tiles = tilesWithSkirts.map((tile) => {
      const baseKey = `${tile.key}:${tile.skirtKey}`;
      const colorKey = `${viewMode}:${baseKey}`;
      geoVisibleKeys.add(baseKey);
      colVisibleKeys.add(colorKey);

      let geometry = geoCache.get(baseKey);
      if (!geometry) {
        geometry = buildBaseGeometry(terrain, tile);
        geoCache.set(baseKey, geometry);
      }

      let colorAttr = colCache.get(colorKey);
      if (!colorAttr) {
        colorAttr = buildTileColorAttribute(terrain, layers, viewMode, tile);
        colCache.set(colorKey, colorAttr);
      }

      if (geometry.attributes.color !== colorAttr) {
        geometry.setAttribute('color', colorAttr);
        geometry.attributes.color.needsUpdate = true;
        geometry.attributes.position.needsUpdate = false;
        geometry.attributes.normal.needsUpdate = false;
      }

      return { key: colorKey, geometry };
    });

    trimCache(geoCache, geoVisibleKeys);
    trimCache(colCache, colVisibleKeys);
    return tiles;
  }, [layers, terrain, viewMode, visibleTiles]);

  return (
    <group dispose={null} userData={{ terrainTiles: renderedTiles.length }}>
      {renderedTiles.map((tile) => (
        <TerrainTile key={tile.key} geometry={tile.geometry} material={material} />
      ))}
    </group>
  );
});

export { MIN_TILE_CELLS as CHUNK_SIZE, LOD_LEVELS, selectVisibleTiles };
