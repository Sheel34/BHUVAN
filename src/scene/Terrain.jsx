import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { analysisColor } from '../engine/terrain';

export default function Terrain({ terrain, layers, viewMode }) {
  const meshRef = useRef();

  const geometry = useMemo(() => {
    const { data, size, scale, minH, maxH } = terrain;
    const geo = new THREE.PlaneGeometry(scale, scale, size - 1, size - 1);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const vIdx = i * size + j;
        const h = data[i * size + j];
        pos.setY(vIdx, h);

        const layerValue =
          viewMode === 'elevation'
            ? (h - minH) / (maxH - minH + 0.001)
            : layers?.[viewMode]?.[vIdx] ?? 0;
        const [r, g, b] = analysisColor(viewMode, layerValue, terrain, h);

        colors[vIdx * 3] = r;
        colors[vIdx * 3 + 1] = g;
        colors[vIdx * 3 + 2] = b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return geo;
  }, [terrain, layers, viewMode]);

  return (
    <mesh ref={meshRef} geometry={geometry} receiveShadow>
      <meshStandardMaterial
        vertexColors
        roughness={0.92}
        metalness={0.05}
        flatShading={false}
      />
    </mesh>
  );
}
