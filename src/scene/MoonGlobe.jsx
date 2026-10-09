import { localToLunarLocation } from '../engine/rehearsal';
import SceneCapture from './SceneCapture';
import GatewayView from './GatewayView';
import PerfStats from './PerfStats';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { latLonToVec3, vec3ToLatLon } from '../lib/moonSites';
import { LUNAR_MISSIONS, MISSION_TYPE_STYLE } from '../lib/lunarMissions';
import { useMobileQuality, WebGLContextStatus, FrameBudget, QUALITY_PROFILES, resolveQuality } from './rendering';
import SpaceEnvironment from './SpaceEnvironment';
import LiquidOptics from './LiquidOptics';
import { ORBIT_BODIES, VISUAL_SUN } from '../engine/orbit';
import { advanceOrbitDays, orbitPose } from '../engine/orbitMotion';

const MOON_RADIUS = 2;
const DISPLACEMENT_SCALE = MOON_RADIUS * .0114; // ~19.8 km / 1737 km; no relief exaggeration
const FLY_DURATION = 2.4;

function easeInOutCubic(t) {
  return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function useMoonTextures(textureUrls, onStatus, onSource) {
  const body = 'moon';
  const [textures, setTextures] = useState(null);
  useEffect(() => {
    let active = true;
    const owned = [];
    const loader = new THREE.TextureLoader().setCrossOrigin('anonymous');
    setTextures(null);
    const load = async (url, label) => {
      try {
        const texture = await loader.loadAsync(url);
        owned.push(texture);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        return texture;
      } catch (error) {
        console.error('[globe] Texture load failed', { body, label, url, error });
        return null;
      }
    };
    onStatus(`Loading ${body === 'earth' ? 'Earth' : 'lunar'} imagery…`);
    (async () => {
      let color = body === 'moon' && textureUrls?.color ? await load(textureUrls.color, 'albedo') : null;
      const backendColor = Boolean(color);
      if (!color && active) color = await load(body === 'earth' ? '/textures/2k_earth_daymap.jpg' : '/textures/2k_moon.jpg', `bundled ${body} albedo`);
      // Never combine a regional/procedural relief map with unrelated albedo.
      const displacement = backendColor && textureUrls?.displacement
        ? await load(textureUrls.displacement, 'LOLA displacement') : null;
      if (!active) { owned.forEach(t => t.dispose()); return; }
      if (color) { color.colorSpace = THREE.SRGBColorSpace; color.anisotropy = 4; }
      setTextures({ color, displacement });
      onSource?.(backendColor ? 'real' : color ? 'bundled' : 'unavailable');
      onStatus(!color ? `${body} imagery unavailable; showing an untextured globe.`
        : backendColor && !displacement ? 'Lunar relief unavailable; showing albedo only.' : '');
    })();
    return () => { active = false; owned.forEach(t => t.dispose()); };
  }, [textureUrls, onStatus, onSource, body]);
  return textures;
}

// Displace on the CPU so actual geometric normals can be recomputed. Sphere
// seam vertices and polar duplicates must agree, including their normals.
export function buildMoonGeometry(displacement) {
  const widthSegments = 256, heightSegments = 128;
  const geometry = new THREE.SphereGeometry(MOON_RADIUS, widthSegments, heightSegments);
  if (!displacement?.image) return geometry;
  const image = displacement.image;
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const pixel = (x, y) => pixels[(y * image.width + ((x % image.width + image.width) % image.width)) * 4] / 255;
  const pole = y => {
    let sum = 0;
    for (let x = 0; x < image.width; x++) sum += pixel(x, y);
    return sum / image.width;
  };
  const north = pole(0), south = pole(image.height - 1);
  const pos = geometry.attributes.position, uv = geometry.attributes.uv;
  const direction = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    const v = uv.getY(k), u = uv.getX(k);
    const x = (u % 1) * image.width - .5;
    const y = Math.max(0, Math.min(image.height - 1, (1 - v) * image.height - .5));
    const x0 = Math.floor(x), y0 = Math.floor(y), y1 = Math.min(image.height - 1, y0 + 1);
    const a = THREE.MathUtils.lerp(pixel(x0, y0), pixel(x0 + 1, y0), x - x0);
    const b = THREE.MathUtils.lerp(pixel(x0, y1), pixel(x0 + 1, y1), x - x0);
    const h = v === 1 ? north : v === 0 ? south : THREE.MathUtils.lerp(a, b, y - y0);
    direction.fromBufferAttribute(pos, k).normalize().multiplyScalar(MOON_RADIUS + (h - .5) * DISPLACEMENT_SCALE);
    pos.setXYZ(k, direction.x, direction.y, direction.z);
  }
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  for (let row = 0; row <= heightSegments; row++) {
    const start = row * (widthSegments + 1);
    const members = row === 0 || row === heightSegments
      ? Array.from({ length: widthSegments + 1 }, (_, k) => start + k)
      : [start, start + widthSegments];
    direction.set(0, 0, 0);
    for (const k of members) direction.add(new THREE.Vector3().fromBufferAttribute(normals, k));
    direction.normalize();
    for (const k of members) normals.setXYZ(k, direction.x, direction.y, direction.z);
  }
  geometry.computeBoundingSphere();
  return geometry;
}

function Moon({ textures, onSurfaceClick }) {
  const down = useRef(null);
  const material = useMemo(() => new THREE.MeshStandardMaterial({
    map: textures?.color || null, color: textures?.color ? '#ffffff' : '#81858b',
    roughness: 1, metalness: 0,
  }), [textures?.color]);
  useEffect(() => () => material.dispose(), [material]);
  const geometry = useMemo(() => {
    try { return buildMoonGeometry(textures?.displacement); }
    catch (error) {
      console.error('[moon] Relief decoding failed; retaining albedo', error);
      return new THREE.SphereGeometry(MOON_RADIUS, 256, 128);
    }
  }, [textures?.displacement]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
      <mesh name="Moon surface" geometry={geometry} material={material} dispose={null}
        onPointerDown={e => { down.current = [e.nativeEvent.clientX, e.nativeEvent.clientY]; }}
        onPointerUp={e => {
          const start = down.current; down.current = null;
          if (!start || Math.hypot(e.nativeEvent.clientX - start[0], e.nativeEvent.clientY - start[1]) > 7) return;
          e.stopPropagation();
          onSurfaceClick?.(e.point);
        }} />
  );
}

function MissionMarker({ mission, moonGroupRef, hovered, onHover, onSelect, flying, mobile }) {
  const markerRef = useRef();
  const dotRef = useRef();
  const style = MISSION_TYPE_STYLE[mission.type] || MISSION_TYPE_STYLE.lander;
  const surfacePos = useMemo(() => latLonToVec3(mission.lat, mission.lon, MOON_RADIUS), [mission]);
  const dir = useMemo(() => new THREE.Vector3(...surfacePos).normalize(), [surfacePos]);
  const tip = useMemo(() => dir.clone().multiplyScalar(MOON_RADIUS * 1.07), [dir]);
  // Orient the stalk to point radially outward from the globe.
  const quat = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    return q;
  }, [dir]);
  const scratch = useMemo(() => ({ center: new THREE.Vector3(), point: new THREE.Vector3(),
    normal: new THREE.Vector3(), view: new THREE.Vector3() }), []);

  useFrame(({ camera, clock }) => {
    if (!markerRef.current || !moonGroupRef.current) return;
    moonGroupRef.current.getWorldPosition(scratch.center);
    const worldPos = markerRef.current.localToWorld(scratch.point.copy(tip));
    const facing = scratch.normal.copy(worldPos).sub(scratch.center).normalize()
      .dot(scratch.view.copy(camera.position).sub(worldPos).normalize());
    markerRef.current.visible = facing > 0.05;
    if (dotRef.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * 2.2 + mission.lat) * 0.15;
      dotRef.current.scale.setScalar(hovered ? 1.8 : pulse);
    }
  });

  return (
    <group ref={markerRef}>
      {/* radial stalk */}
      <mesh position={surfacePos} quaternion={quat}>
        <cylinderGeometry args={[0.009, 0.009, MOON_RADIUS * 0.09, 6]} />
        <meshBasicMaterial color={style.color} transparent opacity={0.9} toneMapped={false} />
      </mesh>
      {/* head */}
      <group position={tip.toArray()}>
        {/* large invisible hit target — small dots are hard to click. Stops
            pointer events so a marker click never also surveys the surface. */}
        <mesh
          onPointerOver={(e) => { e.stopPropagation(); if (!flying) onHover(mission.id); }}
          onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); if (!flying) onSelect(mission); }}
        >
          <sphereGeometry args={[mobile ? .26 : .13, 12, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        {/* outer glow — always visible so markers read at a glance */}
        <mesh>
          <sphereGeometry args={[0.085, 16, 16]} />
          <meshBasicMaterial
            color={style.color}
            transparent
            opacity={hovered ? 0.45 : 0.22}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
        {/* inner halo */}
        <mesh>
          <sphereGeometry args={[0.055, 16, 16]} />
          <meshBasicMaterial
            color={style.color}
            transparent
            opacity={hovered ? 0.7 : 0.4}
            toneMapped={false}
            depthWrite={false}
          />
        </mesh>
        <mesh ref={dotRef}>
          <sphereGeometry args={[0.05, 16, 16]} />
          <meshBasicMaterial color={hovered ? '#ffffff' : style.color} toneMapped={false} />
        </mesh>
        {hovered && !flying && (
          <Html distanceFactor={6} position={[0.06, 0.06, 0]} style={{ pointerEvents: 'none' }}>
            <div className="globe-mission-tag">
              <span className="globe-mission-tag-name">{mission.mission}</span>
              <span className="globe-mission-tag-meta">{mission.country} · {mission.date.slice(0, 4)}</span>
            </div>
          </Html>
        )}
      </group>
    </group>
  );
}

function Earth({ onSurfaceClick, onStatus, cloudLayer }) {
  const [maps, setMaps] = useState({});
  const down = useRef(null);
  useEffect(() => {
    let active = true;
    const owned = [];
    const loader = new THREE.TextureLoader();
    setMaps({});
    onStatus('Loading Earth imagery…');
    const load = async (url, color = false) => {
      try {
        const texture = await loader.loadAsync(url);
        owned.push(texture);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.anisotropy = 8;
        if (color) texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
      } catch (error) { console.error('[earth] Texture load failed', { url, error }); return null; }
    };
    Promise.all([load('/textures/earth-blue-marble-5400.jpg', true),
      load('/textures/2k_earth_specular.png'), load('/textures/2k_earth_normal.png'),
      load(cloudLayer?.content?.url||'/textures/2k_earth_clouds.jpg', true),load('/textures/2k_earth_nightmap.jpg',true)])
      .then(([map, specularMap, normalMap, clouds, night]) => {
        if (!active) { owned.forEach(t => t.dispose()); return; }
        setMaps({ map, specularMap, normalMap, clouds, night });
        onStatus(!map ? 'Earth imagery unavailable; displaying an untextured body.'
          : !specularMap || !normalMap ? 'Earth shading map unavailable; albedo retained.' : '');
      });
    return () => { active = false; owned.forEach(t => t.dispose()); };
  }, [onStatus, cloudLayer]);
  return <>
    <mesh name="Earth surface"
      onPointerDown={e => { down.current = [e.nativeEvent.clientX, e.nativeEvent.clientY]; }}
      onPointerUp={e => {
        const start = down.current; down.current = null;
        if (!start || Math.hypot(e.nativeEvent.clientX-start[0], e.nativeEvent.clientY-start[1]) > 7) return;
        e.stopPropagation(); onSurfaceClick(e.point);
      }}>
      <sphereGeometry args={[ORBIT_BODIES.earth.radius, 128, 64]} />
      {/* Specular map separates oceans from land. No albedo-derived height. */}
      <meshPhysicalMaterial key={maps.map?.uuid || 'loading'} map={maps.map || null} color={maps.map ? '#ffffff' : '#718291'}
        roughness={.85} metalness={0} clearcoat={.12} clearcoatRoughness={.25}
        normalMap={maps.normalMap || null} normalScale={[.45,.45]}
        onBeforeCompile={shader=> {
          if(!maps.map || !maps.specularMap || !maps.night)return;
          shader.uniforms.oceanMask={value:maps.specularMap};shader.uniforms.nightMap={value:maps.night};
          shader.uniforms.sunDirection={value:new THREE.Vector3(...VISUAL_SUN.direction).normalize()};
          shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 earthNormal;')
            .replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nearthNormal=normalize(mat3(modelMatrix)*normal);');
          shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform sampler2D oceanMask;uniform sampler2D nightMap;uniform vec3 sunDirection;varying vec3 earthNormal;')
            .replace('#include <color_fragment>','#include <color_fragment>\nfloat ocean=texture2D(oceanMask,vMapUv).r;diffuseColor.rgb=mix(diffuseColor.rgb,max(diffuseColor.rgb,vec3(.008,.025,.055)),ocean);')
            .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(.9,.23,texture2D(oceanMask,vMapUv).r);')
            .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=texture2D(nightMap,vMapUv).rgb*1.3*(1.-smoothstep(-.2,.1,dot(normalize(earthNormal),sunDirection)));');
        }}/>
    </mesh>
    {maps.clouds && <mesh name="Presentation cloud composite" raycast={() => null}>
      <sphereGeometry args={[ORBIT_BODIES.earth.radius * 1.008, 96, 48]} />
      <meshPhongMaterial map={maps.clouds} alphaMap={maps.clouds} transparent opacity={.65}
        depthWrite={false} shininess={0} />
    </mesh>}
    <mesh name="Visual atmospheric limb" raycast={()=>null}>
      <sphereGeometry args={[ORBIT_BODIES.earth.radius*1.027,64,48]}/>
      <shaderMaterial transparent depthWrite={false} side={THREE.BackSide} blending={THREE.AdditiveBlending}
        vertexShader={'varying vec3 n;varying vec3 v;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=normalize(-p.xyz);gl_Position=projectionMatrix*p;}'}
        fragmentShader={'varying vec3 n;varying vec3 v;void main(){float mu=abs(dot(n,v));float rim=pow(1.-mu,3.)*smoothstep(0.,.12,mu);gl_FragColor=vec4(.12,.34,.64,rim*.15);}'}/>
    </mesh>
  </>;
}

function NavigationController({ navigation, location, flight, locked, active, controlsRef, onFlightDone, moonGroupRef, earthGroupRef }) {
  const { camera, size } = useThree();
  useEffect(() => {
    if (size.width > 820) camera.setViewOffset(size.width, size.height, -size.width * .14, 0, size.width, size.height);
    else camera.clearViewOffset();
    return () => camera.clearViewOffset();
  }, [camera, size.width, size.height]);
  const tween = useRef(null);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const colliders = useMemo(() => Object.values(ORBIT_BODIES).map(body => ({
    center: new THREE.Vector3(...body.center), minimum: body.radius * 1.055 })), []);
  useEffect(() => {
    if (!active || !controlsRef.current) return;
    const level = flight ? 'region' : navigation.level;
    const definition = ORBIT_BODIES[flight?.body || navigation.body];
    const center = definition.id==='moon' && moonGroupRef.current ? moonGroupRef.current.position.clone() : new THREE.Vector3(...definition.center);
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(size.width / size.height, 1));
    const from = camera.position.clone().sub(center);
    let target, toDirection, distance;
    if (level === 'space') {
      center.set(...ORBIT_BODIES.earth.center);
      from.copy(camera.position).sub(center);
      target = center.clone();
      toDirection = new THREE.Vector3(0, .14, 1).normalize();
      distance = 7.8 / Math.sin(halfFov);
    } else if (level === 'region' && (flight || location?.body === definition.id)) {
      const point = flight || { lat: location.latitude, lon: location.longitude };
      toDirection = new THREE.Vector3(...latLonToVec3(point.lat, point.lon, 1));
      toDirection.applyQuaternion((definition.id==='moon'?moonGroupRef:earthGroupRef).current.quaternion);
      target = center.clone().addScaledVector(toDirection, definition.radius);
      distance = definition.radius * 1.32;
    } else {
      target = center.clone();
      toDirection = from.clone().normalize();
      distance = definition.radius * 1.3 / Math.sin(halfFov);
    }
    if (from.lengthSq() < .01) from.set(0, .2, 1);
    tween.current = { elapsed: 0, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? .01 : flight ? FLY_DURATION : 1.35,
      center, direction: from.clone().normalize(), fromDistance: from.length(), distance,
      rotation: new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), toDirection),
      currentRotation: new THREE.Quaternion(), lookFrom: controlsRef.current.target.clone(), target,
      flightComplete: Boolean(flight) };
    controlsRef.current.enabled = false;
    controlsRef.current.minDistance = level === 'space' ? 4 : definition.radius * (level === 'region' ? .12 : 1.1);
    controlsRef.current.maxDistance = level === 'space' ? 80 : Math.max(20, distance * 3);
  }, [navigation, flight, active, camera, size.width, size.height, controlsRef]);

  useEffect(() => {
    if (!tween.current && controlsRef.current) controlsRef.current.enabled = active && !locked;
  }, [locked, active, controlsRef]);

  useFrame((_, dt) => {
    if (!active) return;
    const state = tween.current;
    if (state) {
      if(navigation.body==='moon'&&navigation.level!=='space'&&moonGroupRef.current) {
        scratch.copy(moonGroupRef.current.position).sub(state.center);state.center.add(scratch);state.target.add(scratch);state.lookFrom.add(scratch);
      }
      state.elapsed = Math.min(state.duration, state.elapsed + dt);
      const t = state.elapsed / state.duration, k = easeInOutCubic(t);
      state.currentRotation.identity().slerp(state.rotation, k);
      const r = THREE.MathUtils.lerp(state.fromDistance, state.distance, k)
        + Math.sin(Math.PI * k) * ORBIT_BODIES[navigation.body].radius * .35;
      camera.position.copy(scratch.copy(state.direction).applyQuaternion(state.currentRotation).multiplyScalar(r).add(state.center));
      controlsRef.current.target.copy(state.lookFrom).lerp(state.target, k);
      if (t >= 1) {
        tween.current = null;
        controlsRef.current.enabled = !locked;
        if (state.flightComplete) onFlightDone?.();
      }
    }
    // Visual sphere collision only. Scientific coordinates are never recentered.
    for (const body of colliders) {
      if(body.minimum===ORBIT_BODIES.moon.radius*1.055 && moonGroupRef.current)body.center.copy(moonGroupRef.current.position);
      scratch.copy(camera.position).sub(body.center);
      if (scratch.lengthSq() < body.minimum ** 2) {
        if (scratch.lengthSq() < 1e-10) scratch.set(0, 0, 1);
        camera.position.copy(scratch.normalize().multiplyScalar(body.minimum)).add(body.center);
      }
    }
    camera.lookAt(controlsRef.current.target);
    camera.updateMatrixWorld();
  });
  return null;
}

function LiveRoverMarker({mission}) {
  const marker=useRef();
  useFrame(()=> {
    if(!marker.current)return;
    const position=mission?.route&&mission.body==='moon'&&localToLunarLocation(mission.location,mission.runtime.current.position);
    marker.current.visible=Boolean(position);
    if(position)marker.current.position.fromArray(latLonToVec3(position.lat,position.lon,MOON_RADIUS*1.002));
  });
  if(!mission?.route||mission.body!=='moon'||!mission.location)return null;
  return <group ref={marker} visible={false}><mesh raycast={()=>null}><sphereGeometry args={[.008,12,8]}/><meshBasicMaterial color="#f6c587" toneMapped={false}/></mesh>
    <Html position={[0,.035,0]} occlude center style={{pointerEvents:'none',whiteSpace:'nowrap'}} zIndexRange={[7,0]}><span className="scenario-label">ROVER · REHEARSAL</span></Html></group>;
}

function GlobeScene({ navigation, location, textureUrls, flight, onFlightDone, onFocusBody,
  onSelectMission, onSurfaceClick, locked, active, mobile, onMoonStatus, onEarthStatus, onTextureSource, earthLayers, orbitMotion,onOrbitTime, gatewayView,mission }) {
  const moonGroupRef = useRef();
  const earthGroupRef = useRef();
  const controlsRef = useRef();
  const [hoveredSite, setHoveredSite] = useState(null);
  const textures = useMoonTextures(textureUrls, onMoonStatus, onTextureSource);
  const orbitDays=useRef(0),labels=useRef(),lastReport=useRef(-1);
  const {camera}=useThree();const previousCenter=useMemo(()=>new THREE.Vector3(),[]);
  useFrame((state,dt)=> {
    if(!active||locked)return;
    orbitDays.current=advanceOrbitDays(orbitDays.current,dt,orbitMotion);
    const report=Math.floor(state.clock.elapsedTime);
    if(report!==lastReport.current) {lastReport.current=report;onOrbitTime?.(orbitDays.current);}
    const pose=orbitPose(orbitDays.current);
    if(moonGroupRef.current) {
      previousCenter.copy(moonGroupRef.current.position);
      const p=pose.moonPosition,c=ORBIT_BODIES.earth.center;
      moonGroupRef.current.position.set(c[0]+p[0],c[1]+p[1],c[2]+p[2]);
      moonGroupRef.current.rotation.y=pose.moonRotation;
      if(!gatewayView&&navigation.level!=='space'&&navigation.body==='moon'&&controlsRef.current) {
        previousCenter.sub(moonGroupRef.current.position).negate();camera.position.add(previousCenter);controlsRef.current.target.add(previousCenter);
      }
      if(labels.current) {labels.current.position.copy(moonGroupRef.current.position);labels.current.position.y-=ORBIT_BODIES.moon.radius+.3;}
    }
    if(earthGroupRef.current)earthGroupRef.current.rotation.y=pose.earthRotation;
  });
  const click = (body, group, point) => {
    if (locked || gatewayView) return;
    if (navigation.level === 'space' || navigation.body !== body) { onFocusBody(body); return; }
    const local = group.current.worldToLocal(point.clone());
    const { lat, lon } = vec3ToLatLon(local.x, local.y, local.z);
    onSurfaceClick({ body, lat, lon });
  };
  const definition = ORBIT_BODIES[location?.body || navigation.body];
  const selectedPosition = location && latLonToVec3(location.latitude, location.longitude,
    definition.id === 'moon' ? MOON_RADIUS * 1.012 : definition.radius * 1.006);
  return <>
    <directionalLight position={VISUAL_SUN.direction} intensity={2.4} />
    <ambientLight intensity={.2} />
    <SpaceEnvironment mobile={mobile} decorativeStars />
    <group name="Earth body" visible={!gatewayView&&(navigation.level==='space'||navigation.body==='earth')} ref={earthGroupRef} position={ORBIT_BODIES.earth.center}>
      <Earth onSurfaceClick={point => click('earth', earthGroupRef, point)} onStatus={onEarthStatus}
        cloudLayer={earthLayers.find(layer => layer.kind === 'clouds')} />
      {location?.body === 'earth' && <mesh position={selectedPosition} raycast={() => null}>
        <sphereGeometry args={[.025, 16, 12]} /><meshBasicMaterial color="#b5f5ff" toneMapped={false} />
      </mesh>}
    </group>
    <group name="Moon body" visible={navigation.level==='space'||navigation.body==='moon'} ref={moonGroupRef} position={ORBIT_BODIES.moon.center} scale={ORBIT_BODIES.moon.radius / MOON_RADIUS}>
      <LiveRoverMarker mission={mission}/><Moon textures={textures} onSurfaceClick={point => click('moon', moonGroupRef, point)} />
      {!gatewayView && navigation.body === 'moon' && navigation.level === 'body' && LUNAR_MISSIONS.map(mission =>
        <MissionMarker key={mission.id} mission={mission} moonGroupRef={moonGroupRef}
          hovered={hoveredSite === mission.id} onHover={setHoveredSite}
          onSelect={onSelectMission} flying={locked} mobile={mobile} />)}
      {location?.body === 'moon' && <mesh position={selectedPosition} raycast={() => null}>
        <sphereGeometry args={[.025, 16, 12]} /><meshBasicMaterial color="#b5f5ff" toneMapped={false} />
      </mesh>}
    </group>
    {navigation.level === 'space' && Object.values(ORBIT_BODIES).map(body =>
      <group key={body.id} ref={body.id==='moon'?labels:undefined} position={[body.center[0],body.center[1]-body.radius-.3,body.center[2]]}><Html
        center style={{ pointerEvents: 'none' }} zIndexRange={[2, 0]}>
        <span className="orbit-body-label">{body.id.toUpperCase()}</span>
      </Html></group>)}
    <OrbitControls ref={controlsRef} makeDefault enablePan={false} enableDamping dampingFactor={.08}
      rotateSpeed={.42} zoomSpeed={.7} minDistance={4} maxDistance={80} />
    <>{gatewayView ? <GatewayView moonRef={moonGroupRef} controlsRef={controlsRef}/> : <NavigationController navigation={navigation} location={location} flight={flight} locked={locked}
      active={active} controlsRef={controlsRef} onFlightDone={onFlightDone} moonGroupRef={moonGroupRef} earthGroupRef={earthGroupRef}/>}</>
  </>;
}

const EMPTY_LAYERS = [];
export default function MoonGlobe({ navigation, location, active = true, earthLayers = EMPTY_LAYERS,
  textureUrls, onMissionSelect, onSiteSelected, onFocusBody, flyToMission, onTransitionComplete,
  acquisitionLocked, onGlReady, onTextureSource, orbitMotion, qualityTier,onOrbitTime,gatewayView,performanceOpen,onStats,mission }) {
  const [moonStatus, setMoonStatus] = useState('Loading lunar imagery…');
  const [earthStatus, setEarthStatus] = useState('Loading Earth imagery…');
  const [contextStatus, setContextStatus] = useState('');
  const mobile = useMobileQuality();
  const quality=QUALITY_PROFILES[resolveQuality(qualityTier,mobile)];
  return <div className={'globe-root' + (active ? '' : ' inactive-scene')} aria-hidden={!active}>
    <Canvas frameloop="never"
      camera={{ position: [0, 2, 22], fov: 42, near: .015, far: 200 }}
      gl={{ antialias: quality.antialias, powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 }} dpr={quality.dpr}
      fallback={<span>Interactive planetary overview. Use Moon, Earth and workspace controls to explore.</span>}
      onCreated={({ gl }) => onGlReady?.(gl)}>
      <color attach="background" args={['#070c16']} />
      <WebGLContextStatus onStatus={setContextStatus} label="orbit" />
      <FrameBudget active={active}/>
      <GlobeScene navigation={navigation} location={location} textureUrls={textureUrls}
        flight={flyToMission} onFlightDone={onTransitionComplete} onFocusBody={onFocusBody}
        onSelectMission={onMissionSelect} onSurfaceClick={onSiteSelected}
        locked={acquisitionLocked} active={active} mobile={mobile}
        onMoonStatus={setMoonStatus} onEarthStatus={setEarthStatus} onTextureSource={onTextureSource}
        gatewayView={gatewayView} mission={mission} earthLayers={earthLayers} orbitMotion={orbitMotion} onOrbitTime={onOrbitTime}/>
      <SceneCapture sceneId="orbit" active={active} analysis={mission?.analysis} runtime={mission?.runtime}/><PerfStats enabled={active&&performanceOpen} onStats={onStats}/>{active && <LiquidOptics />}
    </Canvas>
    {active&&<button className="orbital-capture terrain-focus-control" onClick={()=>window.dispatchEvent(new CustomEvent('bhuvan-capture-frame',{detail:'orbit'}))}>CAPTURE ORBIT VIEW</button>}
    {active&&mission?.route&&mission.body==='moon'&&mission.location&&<div className="orbital-mission-telemetry">
      <b>ROVER REHEARSAL · {(mission.runtime.current.progress*100).toFixed(1)}%</b>
      <p>{localToLunarLocation(mission.location,mission.runtime.current.position)?.lat.toFixed(6)}° N · {localToLunarLocation(mission.location,mission.runtime.current.position)?.lon.toFixed(6)}° E</p>
      <p>{mission.runtime.current.distance.toFixed(1)} m travelled · {mission.runtime.current.observations?.length||0} map samples</p>
      <small>The amber surface marker follows this route in lunar body coordinates. Motion is small at globe scale.</small>
    </div>}
    {active && (contextStatus || moonStatus || earthStatus) && <div className="scene-status" role="status">
      {contextStatus || moonStatus || earthStatus}
    </div>}
  </div>;
}
