import * as THREE from 'three';
import { terrainTiles, TILE_CELLS, windowValue } from '../engine/tileSource.js';

export function trimGeometryCache(cache, retainedKeys, limit=64) {
  for(const [key,tile] of cache)if(cache.size>limit && !retainedKeys.has(key)) {
    tile.geometry.dispose();tile.boundary?.dispose();cache.delete(key);
  }
}

export const createTerrainTiles = terrain => terrainTiles(terrain.size);

// A common deterministic LOD for all visible tiles avoids mixed-edge topology.
// Every boundary retains native samples. Coarse boundary cells use triangle
// fans, not vertical skirts. Authoritative analysis rasters are never decimated.
export function buildTerrainTile(terrain, tile, window = null) {
  const { data, size, scale } = terrain;
  const step = tile.step || 1, cell = scale/(size-1);
  const height = (i,j) => window ? windowValue(window, 'height', i,j) : data[i*size+j];
  const range = (a,b, stride) => { const r=[]; for(let k=a;k<b;k+=stride)r.push(k); r.push(b); return r; };
  const xs = range(tile.i0,tile.i1,step), zs = range(tile.j0,tile.j1,step);
  const positions=[], normals=[], uvs=[], samples=[], indices=[], vertices=new Map();
  const centerX = ((tile.i0+tile.i1)/2/(size-1)-.5)*scale;
  const centerZ = ((tile.j0+tile.j1)/2/(size-1)-.5)*scale;
  const vertex = (i,j) => {
    const key = `${i}:${j}`;
    if(vertices.has(key))return vertices.get(key);
    const k=positions.length/3; vertices.set(key,k);
    const halo=window?.rowIndices ? step : 1;
    const i0=Math.max(0,i-halo), i1=Math.min(size-1,i+halo), j0=Math.max(0,j-halo), j1=Math.min(size-1,j+halo);
    const dx=(height(i1,j)-height(i0,j))/((i1-i0)*cell), dz=(height(i,j1)-height(i,j0))/((j1-j0)*cell);
    const length=Math.hypot(dx,1,dz);
    positions.push((i/(size-1)-.5)*scale-centerX,height(i,j),(j/(size-1)-.5)*scale-centerZ);
    normals.push(-dx/length,1/length,-dz/length);
    uvs.push(j/(size-1),1-i/(size-1)); samples.push(i,j);
    return k;
  };
  for(let a=0;a<xs.length-1;a++)for(let b=0;b<zs.length-1;b++) {
    const i=xs[a],i1=xs[a+1],j=zs[b],j1=zs[b+1];
    const A=vertex(i,j), B=vertex(i,j1), C=vertex(i1,j1), D=vertex(i1,j);
    if(window?.rowIndices || step===1 || (a>0 && b>0 && a<xs.length-2 && b<zs.length-2)) {
      indices.push(A,B,D,D,B,C); continue;
    }
    const polygon=[A];
    if(a===0)for(let n=j+1;n<j1;n++)polygon.push(vertex(i,n));
    polygon.push(B);
    if(b===zs.length-2)for(let n=i+1;n<i1;n++)polygon.push(vertex(n,j1));
    polygon.push(C);
    if(a===xs.length-2)for(let n=j1-1;n>j;n--)polygon.push(vertex(i1,n));
    polygon.push(D);
    if(b===0)for(let n=i1-1;n>i;n--)polygon.push(vertex(n,j));
    // Convex cell polygon, triangulated from its existing corner. Collinear
    // border vertices need an interior centre so every edge sample is retained.
    const ci=(i+i1)/2, cj=(j+j1)/2;
    const h=(height(i,j)+height(i1,j)+height(i,j1)+height(i1,j1))/4;
    const mid=positions.length/3;
    positions.push((ci/(size-1)-.5)*scale-centerX,h,(cj/(size-1)-.5)*scale-centerZ);
    const n=new THREE.Vector3(normals[A*3],normals[A*3+1],normals[A*3+2]);
    normals.push(n.x,n.y,n.z);uvs.push(cj/(size-1),1-ci/(size-1));samples.push(ci,cj);
    for(let k=0;k<polygon.length;k++)indices.push(mid,polygon[k],polygon[(k+1)%polygon.length]);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  geometry.setAttribute('color',new THREE.BufferAttribute(new Float32Array(positions.length),3));
  geometry.setIndex(indices);geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.userData={ samples, centerX, centerZ, tileId:tile.key, lod:Math.log2(step) };
  return geometry;
}

export function selectVisibleTiles(terrain,camera,height) {
  const matrix=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(matrix);
  const distance=Math.max(terrain.scale/(terrain.size-1),camera.position.distanceTo(new THREE.Vector3(0,(terrain.minH+terrain.maxH)/2,0)));
  const pixels=(terrain.scale/(terrain.size-1))*height/(2*distance*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)));
  const step=2**THREE.MathUtils.clamp(Math.floor(Math.log2(1/Math.max(pixels,.001))),0,4);
  return createTerrainTiles(terrain).filter(tile=> {
    const x=i=>(i/(terrain.size-1)-.5)*terrain.scale;
    const box=new THREE.Box3(new THREE.Vector3(x(tile.i0),terrain.minH,x(tile.j0)),new THREE.Vector3(x(tile.i1),terrain.maxH,x(tile.j1)));
    return frustum.intersectsBox(box);
  }).map(tile=>({...tile,step,cacheKey:`${tile.key}:${step}`}));
}

// A spatial hierarchy prunes branches before creating tile descriptors. The
// logical raster never becomes a list of 65,536 native tiles per frame.
// Common visible level + atomic replacement is the edge strategy: mixed LOD
// neighbors are never simultaneously displayed in the streamed working set.
export function selectStreamedTiles(terrain,camera,height,target,maxActive=31) {
  const matrix=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const frustum=new THREE.Frustum().setFromProjectionMatrix(matrix);
  const cell=terrain.scale/(terrain.size-1), maxLevel=terrain.stream.max_level;
  const distance=Math.max(cell,camera.position.distanceTo(target || new THREE.Vector3(0,terrain.maxH/2,0)));
  const pixels=cell*height/(2*distance*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)));
  let level=THREE.MathUtils.clamp(Math.floor(Math.log2(1/Math.max(pixels,1e-9))),0,maxLevel);
  const physical=i=>(i/(terrain.size-1)-.5)*terrain.scale;
  const box=new THREE.Box3();
  const select=level=> {
    const result=[], span=TILE_CELLS*2**level;
    function visit(i,j,width) {
      if(result.length>maxActive || i>=terrain.size-1 || j>=terrain.size-1)return;
      const i1=Math.min(i+width,terrain.size-1),j1=Math.min(j+width,terrain.size-1);
      box.min.set(physical(i),terrain.minH,physical(j));box.max.set(physical(i1),terrain.maxH,physical(j1));
      if(!frustum.intersectsBox(box))return;
      if(width===span) {
        const x=j/span,y=i/span,key=`${level}/${x}/${y}`;
        result.push({i0:i,j0:j,i1,j1,step:2**level,level,x,y,key,cacheKey:key});
      } else {const h=width/2;visit(i,j,h);visit(i+h,j,h);visit(i,j+h,h);visit(i+h,j+h,h);}
    }
    visit(0,0,TILE_CELLS*2**maxLevel);return result;
  };
  let selected=select(level);
  while(selected.length>maxActive && level<maxLevel)selected=select(++level);
  return selected;
}

// Only outer dataset edges have walls. Interior neighbors share the same
// sample lattice; no inter-tile skirts are generated.
export function buildTileBoundary(terrain,tile,window) {
  const positions=[],indices=[],scale=terrain.scale,cell=scale/(terrain.size-1);
  const cx=tile.geometry.userData.centerX,cz=tile.geometry.userData.centerZ,bottom=terrain.minH-scale*.025;
  const edges=[];
  if(tile.i0===0)edges.push(window.columnIndices.filter(j=>j>=tile.j0 && j<=tile.j1).map(j=>[0,j]));
  if(tile.i1===terrain.size-1)edges.push(window.columnIndices.filter(j=>j>=tile.j0 && j<=tile.j1).map(j=>[tile.i1,j]));
  if(tile.j0===0)edges.push(window.rowIndices.filter(i=>i>=tile.i0 && i<=tile.i1).map(i=>[i,0]));
  if(tile.j1===terrain.size-1)edges.push(window.rowIndices.filter(i=>i>=tile.i0 && i<=tile.i1).map(i=>[i,tile.j1]));
  for(const edge of edges) {
    const offset=positions.length/3;
    edge.forEach(([i,j],k)=> {
      const x=i*cell-scale/2-cx,z=j*cell-scale/2-cz;
      positions.push(x,windowValue(window,'height',i,j),z,x,bottom,z);
      if(k) {const a=offset+(k-1)*2,b=offset+k*2;indices.push(a,a+1,b,b,a+1,b+1);}
    });
  }
  if(!positions.length)return null;
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);geometry.computeBoundingSphere();return geometry;
}

