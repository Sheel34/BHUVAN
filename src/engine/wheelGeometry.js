import * as THREE from 'three';

// Only the verified wheel primitives in the two supplied NASA meshes are used.
// Cut planes lie in empty gaps between axles; no triangle may cross a partition.
export const WHEEL_RIGS = Object.freeze({
  curiosity: {radius:.24265, vertexCount:16452, sideCut:-1, axleCuts:[-1.719,-.5893],
    centers:[[-2.121638,.005216,-2.258087],[-2.252305,.003621,-1.181844],[-2.121543,.010227,.002903],
      [.004107,.001172,-2.255343],[.134773,.002928,-1.181588],[.004336,.010209,.003126]]},
  perseverance: {radius:.263, sideCut:0, axleCuts:[-.59255,.5375],
    centers:[[-1.062486,-.000288,-1.129983],[-1.184485,.000107,-.055006],[-1.062486,-.000288,1.129983],
      [1.062486,.000502,-1.129989],[1.184485,.000107,-.055006],[1.062486,-.000288,1.129983]]},
});

export function partitionWheelGeometry(geometry, rig) {
  const p=geometry.attributes.position, index=geometry.index;
  const faceCount=(index?.count||p.count)/3,buckets=Array.from({length:6},()=>[]);
  const bin=i => (p.getX(i)<rig.sideCut?0:3)+(p.getZ(i)<rig.axleCuts[0]?0:p.getZ(i)<rig.axleCuts[1]?1:2);
  for(let k=0;k<faceCount;k++) {
    const a=index?index.getX(k*3):k*3,b=index?index.getX(k*3+1):k*3+1,c=index?index.getX(k*3+2):k*3+2;
    const slot=bin(a);
    if(bin(b)!==slot||bin(c)!==slot)throw new Error('Wheel partition crosses a triangle; keep the original mesh.');
    buckets[slot].push(a,b,c);
  }
  if(buckets.some(b=>!b.length))throw new Error('Wheel primitive must contain all six wheels.');
  return buckets.map((indices,k)=> {
    const unique=[...new Set(indices)],remap=new Map(unique.map((v,i)=>[v,i]));
    const part=new THREE.BufferGeometry();
    for(const [name,attr] of Object.entries(geometry.attributes)) {
      const values=new attr.array.constructor(unique.length*attr.itemSize);
      for(let i=0;i<unique.length;i++)for(let j=0;j<attr.itemSize;j++)values[i*attr.itemSize+j]=attr.array[unique[i]*attr.itemSize+j];
      if(name==='position')for(let i=0;i<unique.length;i++)for(let j=0;j<3;j++)values[i*3+j]-=rig.centers[k][j];
      part.setAttribute(name,new THREE.BufferAttribute(values,attr.itemSize,attr.normalized));
    }
    part.setIndex(indices.map(v=>remap.get(v)));part.computeBoundingBox();part.computeBoundingSphere();return part;
  });
}
