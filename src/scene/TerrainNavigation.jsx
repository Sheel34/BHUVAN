import { useCallback, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { sampleHeight } from '../engine/terrain';
import { constrainTerrainCamera } from '../engine/world';
import { terrainCameraLimits, terrainFrameDistance } from '../engine/terrainNavigation';

export default function TerrainNavigation({ terrain, ready, focusPoint, verticalExaggeration, cursorHit, onStats, navigationRef, dragging, roverView='orbit', roverRuntime, roverRoute, keepMetricZoom, cameraMemory }) {
  const ref = useRef(), tween = useRef(null), fitState = useRef(null), anchor = useRef(null);
  const initialHeightPending = useRef(true);
  const { camera, size, scene, raycaster, pointer, gl } = useThree();
  const limits = terrainCameraLimits(terrain, verticalExaggeration);
  const constrain = useCallback(() => {
    if (!ref.current || roverView!=='orbit') return;
    const t = ref.current.target, a = anchor.current;
    const pinned = a && Math.abs(a.x - t.x) < 1e-7 && Math.abs(a.z - t.z) < 1e-7;
    constrainTerrainCamera(camera, ref.current, terrain, { verticalExaggeration, targetHeight: pinned ? a.y : undefined });
    anchor.current = { x: t.x, y: t.y, z: t.z };
  }, [camera, terrain, verticalExaggeration, roverView]);
  const start = useCallback((point, mode = 'pivot') => {
    if (!ref.current || !point) return;
    initialHeightPending.current = false;
    const half = terrain.scale / 2;
    const destination = new THREE.Vector3(THREE.MathUtils.clamp(point.x, -half, half),
      Number.isFinite(point.y) ? point.y * verticalExaggeration : sampleHeight(terrain, point.x, point.z) * verticalExaggeration,
      THREE.MathUtils.clamp(point.z, -half, half));
    const offset = camera.position.clone().sub(ref.current.target);
    const distance = offset.length();
    const closer = mode === 'object' ? Math.max(limits.minDistance*1.05,9)
      : mode === 'focus' ? Math.max(limits.minDistance * 1.5, Math.min(distance * .48, terrain.scale * .18)) : distance;
    tween.current = { elapsed: 0, from: ref.current.target.clone(), destination,
      fromCamera: camera.position.clone(), toCamera: destination.clone().add(offset.multiplyScalar(closer / distance)),
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? .01 : .35 };
  }, [camera, terrain, verticalExaggeration, limits.minDistance]);
  const frameAll = useCallback((initial = false) => {
    initialHeightPending.current = initial;
    const fit = terrainFrameDistance(terrain, camera.fov, size.width / size.height, verticalExaggeration);
    const target = new THREE.Vector3(0, sampleHeight(terrain, 0, 0) * verticalExaggeration, 0);
    ref.current.target.copy(target); anchor.current = { x: target.x, y: target.y, z: target.z };
    camera.position.set(-fit * .45, terrain.maxH * verticalExaggeration + fit * .65, fit * .7);
    tween.current = null; ref.current.update(); constrain();
    return fit;
  }, [terrain, camera, size.width, size.height, verticalExaggeration, constrain]);
  useEffect(() => {
    if (!ref.current) return;
    const fit = terrainFrameDistance(terrain, camera.fov, size.width / size.height, verticalExaggeration);
    camera.near = limits.near;
    camera.far = Math.max(terrain.scale * 12, (terrain.maxH - terrain.minH) * verticalExaggeration * 8, fit * 6);
    if (fitState.current?.terrain === terrain && fitState.current.exaggeration === verticalExaggeration) {
      camera.position.sub(ref.current.target).multiplyScalar(fit / fitState.current.fit).add(ref.current.target);
    } else if (fitState.current?.terrain === terrain) {
      const ratio = verticalExaggeration / fitState.current.exaggeration;
      ref.current.target.y *= ratio; camera.position.y *= ratio; anchor.current = null; constrain();
    } else if(keepMetricZoom&&cameraMemory?.current?.body===terrain.body) {
      const target=new THREE.Vector3(0,sampleHeight(terrain,0,0)*verticalExaggeration,0);
      ref.current.target.copy(target);camera.position.fromArray(cameraMemory.current.offset).add(target);anchor.current=null;initialHeightPending.current=true;constrain();
    } else frameAll(true);
    fitState.current = { terrain, fit, exaggeration: verticalExaggeration };
    camera.updateProjectionMatrix(); ref.current.update(); constrain();
  }, [terrain, camera, size.width, size.height, verticalExaggeration, limits.near, frameAll, constrain, keepMetricZoom, cameraMemory]);
  useEffect(() => {
    if (!ready || !initialHeightPending.current || !ref.current) return;
    initialHeightPending.current = false;
    const t = ref.current.target, y = sampleHeight(terrain, t.x, t.z) * verticalExaggeration;
    camera.position.y += y - t.y; t.y = y; anchor.current = { x:t.x, y, z:t.z };
    constrain();
  }, [ready, terrain, verticalExaggeration, camera, constrain]);
  const startRef = useRef(start); startRef.current = start;
  // A visual exaggeration/viewport change must not replay an old click after a
  // pan. Focus requests are consumed once, on their own identity change.
  useEffect(() => { if (focusPoint) startRef.current(focusPoint, focusPoint.mode || 'focus'); }, [focusPoint]);
  useEffect(() => {
    navigationRef.current = { pivot: p => start(p, 'pivot'), focus: p => start(p, 'focus'), frameAll };
    const focus = () => {
      if (cursorHit.current) {
        const meshes = []; scene.getObjectByName('DEM')?.traverseVisible(o => { if (o.geometry?.userData.tileId) meshes.push(o); });
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(meshes, false)[0];
        if (hit) cursorHit.current = { x: hit.point.x, y: hit.point.y / verticalExaggeration, z: hit.point.z };
      }
      start(cursorHit.current || { ...anchor.current, y: (anchor.current?.y || 0) / verticalExaggeration }, 'focus');
    };
    const key = e => {
      if (e.defaultPrevented || /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName) || e.target?.isContentEditable) return;
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); focus(); }
    };
    window.addEventListener('keydown', key); window.addEventListener('bhuvan-focus-cursor', focus);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('bhuvan-focus-cursor', focus); navigationRef.current = null; };
  }, [start, frameAll, cursorHit, navigationRef, verticalExaggeration, scene, raycaster, pointer, camera]);
  const telemetry = useRef(0);
  const previousView=useRef('orbit'),savedView=useRef(null);
  const look=useRef({yaw:0,pitch:0}),followCenter=useRef(new THREE.Vector3()),followDelta=useRef(new THREE.Vector3());
  useEffect(()=> {
    if(roverView!=='rover')return;
    const element=gl.domElement;let dragLook=null;
    const down=e=> {if(e.button===0)dragLook={x:e.clientX,y:e.clientY};};
    const move=e=> {if(!dragLook)return;look.current.yaw-=(e.clientX-dragLook.x)*.005;look.current.pitch=Math.max(-1.2,Math.min(1.2,look.current.pitch-(e.clientY-dragLook.y)*.005));dragLook={x:e.clientX,y:e.clientY};};
    const up=()=>{dragLook=null;};
    element.addEventListener('pointerdown',down);window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',up);
    return ()=>{element.removeEventListener('pointerdown',down);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',up);};
  },[gl,roverView]);
  useEffect(()=> {
    const preset=e=> {
      if(!roverRoute || roverView==='orbit' || !ref.current)return;
      const p=roverRuntime.current,angle=e.detail==='front'?Math.PI:e.detail==='side'?Math.PI/2:0;
      look.current={yaw:angle,pitch:0};
      if(roverView==='chase') {
        const heading=p.heading+angle;
        camera.position.copy(ref.current.target).add(followDelta.current.set(-Math.sin(heading)*8,4,-Math.cos(heading)*8));ref.current.update();
      }
    };
    window.addEventListener('bhuvan-rover-angle',preset);return ()=>window.removeEventListener('bhuvan-rover-angle',preset);
  },[camera,roverRuntime,roverRoute,roverView]);
  useFrame((_, dt) => {
    if(roverView==='orbit'&&ref.current&&cameraMemory)cameraMemory.current={body:terrain.body,offset:[camera.position.x-ref.current.target.x,camera.position.y-ref.current.target.y,camera.position.z-ref.current.target.z]};
    if(roverView!=='orbit' && roverRoute && ref.current) {
      if(previousView.current==='orbit')savedView.current={position:camera.position.clone(),target:ref.current.target.clone(),near:camera.near};
      const p=roverRuntime.current,chase=roverView==='chase';
      const chassisY=(p.support?.centerHeight??p.position[1])*verticalExaggeration;
      followDelta.current.set(p.position[0],chassisY+.4,p.position[2]);
      if(previousView.current!==roverView) {
        camera.near=.03;camera.updateProjectionMatrix();look.current={yaw:0,pitch:0};
        ref.current.target.copy(followDelta.current);
        camera.position.set(p.position[0]-Math.sin(p.heading)*8,chassisY+4,p.position[2]-Math.cos(p.heading)*8);
        followCenter.current.copy(followDelta.current);ref.current.update();
      }
      if(chase) {
        // Translate the user's current orbit offset; never overwrite its angle.
        followDelta.current.sub(followCenter.current);camera.position.add(followDelta.current);ref.current.target.add(followDelta.current);
        followCenter.current.set(p.position[0],chassisY+.4,p.position[2]);
        const localGround=terrain.tileSource ? terrain.tileSource.sample('height',(camera.position.x/terrain.scale+.5)*(terrain.size-1),(camera.position.z/terrain.scale+.5)*(terrain.size-1)) : sampleHeight(terrain,camera.position.x,camera.position.z);
        if(Number.isFinite(localGround))camera.position.y=Math.max(camera.position.y,localGround*verticalExaggeration+.7);
        ref.current.update();
      } else {
        const heading=p.heading+look.current.yaw,pitch=look.current.pitch+p.pitch;
        camera.position.set(p.position[0],chassisY+1.8,p.position[2]);
        ref.current.target.set(p.position[0]+Math.sin(heading)*Math.cos(pitch)*15,camera.position.y+Math.sin(pitch)*15,p.position[2]+Math.cos(heading)*Math.cos(pitch)*15);
        camera.lookAt(ref.current.target);
      }
      camera.updateMatrixWorld();tween.current=null;previousView.current=roverView;
    } else if(previousView.current!=='orbit') {
      if(savedView.current) {camera.position.copy(savedView.current.position);ref.current.target.copy(savedView.current.target);camera.near=savedView.current.near;camera.updateProjectionMatrix();ref.current.update();}
      previousView.current='orbit';anchor.current=null;
    }
    const flight = tween.current;
    if (flight && ref.current) {
      flight.elapsed = Math.min(1, flight.elapsed + dt / flight.duration);
      const k = flight.elapsed ** 2 * (3 - 2 * flight.elapsed);
      ref.current.target.copy(flight.from).lerp(flight.destination, k);
      camera.position.copy(flight.fromCamera).lerp(flight.toCamera, k);
      anchor.current = { x: ref.current.target.x, y: ref.current.target.y, z: ref.current.target.z };
      if (flight.elapsed === 1) tween.current = null;
    }
    if (flight) constrain();
    if (import.meta.env.DEV && performance.now() - telemetry.current > 500 && ref.current) {
      telemetry.current = performance.now();
      const stats = { camera: camera.position.toArray(), orbitTarget: ref.current.target.toArray(),
        distanceToTarget: camera.position.distanceTo(ref.current.target), cursorTerrainHit: cursorHit.current,
        terrainBounds: [-terrain.scale / 2, -terrain.scale / 2, terrain.scale / 2, terrain.scale / 2],
        grid: [terrain.size, terrain.size], near: camera.near, far: camera.far,
        minDistance: ref.current.minDistance, maxDistance: ref.current.maxDistance, verticalExaggeration };
      globalThis.__BHUVAN_NAVIGATION_STATS__ = stats; onStats?.(stats);
    }
  });
  return <OrbitControls ref={ref} makeDefault enabled={!dragging && roverView!=='rover'} enablePan={roverView==='orbit'} enableDamping dampingFactor={.12}
    rotateSpeed={.6} zoomSpeed={.7} panSpeed={.85} screenSpacePanning={false} zoomToCursor={false}
    mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
    touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
    maxPolarAngle={Math.PI * .46} minPolarAngle={.05}
    minDistance={roverView==='chase'?3:limits.minDistance} maxDistance={roverView==='chase'?60:limits.maxDistance}
    onStart={() => { tween.current = null; initialHeightPending.current = false; }} onChange={constrain} />;
}
