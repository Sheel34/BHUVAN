import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { surfaceOutputs } from './SurfaceEffects';
import { useLiquidPreferences } from '../components/LiquidPreferences';
import { waterPressure, waterShadow } from '../engine/waterFeedback';

function lensGeometry(width, height) {
  // A convex water volume rather than a flat extruded plaque.
  const radius=Math.min(24,width/2,height/2),straightX=Math.max(0,width/2-radius),straightY=Math.max(0,height/2-radius);
  const geometry=new THREE.SphereGeometry(radius,48,24),position=geometry.attributes.position;
  for(let i=0;i<position.count;i++) {
    const x=position.getX(i),y=position.getY(i);
    position.setXYZ(i,x+(x>1e-5?straightX:x<-1e-5?-straightX:0),y+(y>1e-5?straightY:y<-1e-5?-straightY:0),position.getZ(i)*.55);
  }
  geometry.computeVertexNormals();geometry.computeBoundingSphere();
  return geometry;
}

function capsuleShadow() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    uniforms: { extent: { value: new THREE.Vector2() }, halfButton: { value: new THREE.Vector2() }, softness: { value: 3.2 }, offset:{value:new THREE.Vector2(6,-8)},opacity:{value:.22} },
    vertexShader: `varying vec2 shadowUv;
      void main() { shadowUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 shadowUv;
      uniform vec2 extent; uniform vec2 halfButton; uniform float softness; uniform vec2 offset; uniform float opacity;
      void main() {
        float radius = min(24.0, min(halfButton.x, halfButton.y));
        vec2 q = abs((shadowUv - .5) * extent) - (halfButton - vec2(radius));
        float edge = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
        float outside = max(edge, 0.0) / softness;
        vec2 originalQ=abs((shadowUv-.5)*extent+offset)-(halfButton-vec2(radius));
        float originalEdge=length(max(originalQ,0.))+min(max(originalQ.x,originalQ.y),0.)-radius;
        float alpha = opacity * exp(-.5 * outside * outside) * smoothstep(-1.,2.,originalEdge);
        gl_FragColor = vec4(.018, .027, .045, alpha);
      }`,
  });
}

function liquidLightMap() {
  const w=128,h=64,data=new Uint8Array(w*h*4),direction=new THREE.Vector3(-200,300,600).normalize(),v=new THREE.Vector3();
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const latitude=(y/(h-1)-.5)*Math.PI,longitude=x/w*Math.PI*2;
    v.set(Math.cos(latitude)*Math.cos(longitude),Math.sin(latitude),Math.cos(latitude)*Math.sin(longitude));
    const key=Math.exp((v.dot(direction)-1)*28),fill=Math.max(0,v.y)*.16;
    const k=(y*w+x)*4;
    data.set([Math.min(255,(.035+fill+key*.9)*255),Math.min(255,(.065+fill+key*.9)*255),Math.min(255,(.10+fill+key*.9)*255),255],k);
  }
  const map=new THREE.DataTexture(data,w,h,THREE.RGBAFormat);map.mapping=THREE.EquirectangularReflectionMapping;map.needsUpdate=true;return map;
}

// A second scene uses the real rendered terrain/orbit as its optical background.
// DOM buttons retain keyboard, touch, focus and application event handling.
export default function LiquidOptics({ renderMain = true }) {
  const { gl, scene, camera } = useThree();
  const { depth } = useLiquidPreferences();
  const depthRef = useRef(depth); depthRef.current = depth;
  const controls = useRef([]), failed = useRef(false);
  const resources = useMemo(() => {
    const hud = new THREE.Scene();
    const view = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 2500);
    view.position.z = 1000;
    const background = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial());
    background.position.z = -100; hud.add(background);
    hud.add(new THREE.HemisphereLight('#e4e6ff', '#393c65', 1.5));
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(-200, 300, 600); hud.add(key);
    const rim = new THREE.DirectionalLight('#bac4f5', .35);
    rim.position.set(300, -150, 350); hud.add(rim);
    const worldTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    return { hud, view, background, worldTarget, buffer: new THREE.Vector2() };
  }, []);

  useEffect(() => {
    const room = liquidLightMap(), pmrem = new THREE.PMREMGenerator(gl);
    const environment = pmrem.fromEquirectangular(room);
    resources.hud.environment = environment.texture;
    room.dispose(); pmrem.dispose();
    const root = gl.domElement.closest('.simulation-root');
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const abort = new AbortController(); let pending = 0;
    const release = control => {
      control.abort.abort(); control.element.removeAttribute('data-optical');
      resize.unobserve(control.element); resources.hud.remove(control.group, control.shadow);
      control.group.children.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
      control.shadow.geometry.dispose(); control.shadow.material.dispose();
    };
    const measure = () => {
      pending = 0;
      const bounds = gl.domElement.getBoundingClientRect();
      const nodes = [...(root?.querySelectorAll('[data-liquid-control],[data-liquid-surface]') || [])]
        .filter(node => {
          if(!node.getClientRects().length || getComputedStyle(node).visibility==='hidden' || node.closest('.inactive-scene,.closed'))return false;
          const panel=node.closest('.hud-left-panel,.hud-right-panel');
          if(!panel||panel===node)return true;
          const p=panel.getBoundingClientRect(),r=node.getBoundingClientRect();
          return r.top>=p.top+3 && r.bottom<=p.bottom-3 && r.right>bounds.left && r.left<bounds.right;
        });
      controls.current.filter(control => !nodes.includes(control.element)).forEach(release);
      controls.current = nodes.map(element => {
        let control = controls.current.find(item => item.element === element);
        const rect = element.getBoundingClientRect();
        const pressure = Number(element.style.getPropertyValue('--water-pressure')) || 0;
        const width = rect.width / (1 - .025 * pressure), height = rect.height / (1 - .025 * pressure);
        if (!control) {
          control = { element, surface:element.hasAttribute('data-liquid-surface'), group: new THREE.Group(), width: 0, height: 0, tx: 0, ty: 0, baseY: 0,
            abort: new AbortController() };
          control.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capsuleShadow());
          resources.hud.add(control.group, control.shadow);
          const options = { signal: control.abort.signal };
          resize.observe(element);
          const reset = () => { control.tx = control.ty = 0; };
          element.addEventListener('pointermove', event => {
            if (control.surface || motion.matches || event.pointerType === 'touch' || element.disabled) return;
            const box = element.getBoundingClientRect();
            control.tx = THREE.MathUtils.clamp((.5 - (event.clientY - box.top) / box.height) * .22, -.11, .11);
            control.ty = THREE.MathUtils.clamp(((event.clientX - box.left) / box.width - .5) * .22, -.11, .11);
          }, options);
          ['pointerleave', 'pointercancel', 'pointerup', 'blur'].forEach(type => element.addEventListener(type, reset, options));
        }
        if (Math.abs(width - control.width) > .25 || Math.abs(height - control.height) > .25) {
          control.group.children.forEach(mesh => { mesh.geometry.dispose(); mesh.material.dispose(); });
          control.group.clear();
          const lens = new THREE.Mesh(lensGeometry(width, height), new THREE.MeshPhysicalMaterial({
            color: '#e4e8eb', metalness: 0, roughness: control.surface ? .09 : .025, transmission: 1, ior: 1.333,
            thickness: 8 + depthRef.current * .42, clearcoat: 1, clearcoatRoughness: .08, envMapIntensity: .7,
            attenuationColor: control.surface?'#6c7379':'#d4dce2', attenuationDistance: control.surface?90:320 }));
          const wave={value:0},phase={value:0};lens.material.userData.wave=wave;lens.material.userData.phase=phase;
          lens.material.onBeforeCompile=shader=> {
            shader.uniforms.liquidWave=wave;shader.uniforms.liquidPhase=phase;
            shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform float liquidWave;uniform float liquidPhase;')
              .replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.z+=sin(position.x*.17+liquidPhase)*cos(position.y*.22-liquidPhase)*liquidWave;');
          };
          control.group.add(lens); control.width = width; control.height = height;
          // Four blur radii of empty space on every side prevent rectangular cuts.
          const padding = 3.2 * 4;
          control.shadow.scale.set(width + padding * 2, height + padding * 2, 1);
          control.shadow.material.uniforms.extent.value.set(width + padding * 2, height + padding * 2);
          control.shadow.material.uniforms.halfButton.value.set(width / 2, height / 2);
        }
        const x = rect.left - bounds.left + rect.width / 2 - bounds.width / 2;
        const y = bounds.height / 2 - (rect.top - bounds.top + rect.height / 2) + pressure * 3;
        control.baseY = y;control.baseX=x;
        control.group.position.set(x, y, control.surface?-30:0);
        // Shadow is a sibling: it stays close and fixed while the lens tilts.
        control.shadow.position.set(x+6, y-8, control.surface?-65:-45);
        control.group.visible = control.shadow.visible = rect.width > 0 && rect.height > 0;
        return control;
      });
      resources.view.left = -bounds.width / 2; resources.view.right = bounds.width / 2;
      resources.view.top = bounds.height / 2; resources.view.bottom = -bounds.height / 2;
      resources.view.updateProjectionMatrix(); resources.background.scale.set(bounds.width, bounds.height, 1);
    };
    const schedule = () => { if (!pending) pending = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule); resize.observe(gl.domElement);
    const mutation = new MutationObserver(schedule);
    if (root) mutation.observe(root, { childList: true, subtree: true, attributes:true, attributeFilter:['class','hidden','open'] });
    window.addEventListener('resize', schedule, { signal: abort.signal });
    window.addEventListener('scroll', schedule, { signal: abort.signal, capture: true });
    motion.addEventListener('change', () => controls.current.forEach(control => {
      control.tx = control.ty = 0; control.group.rotation.set(0, 0, 0);
    }), { signal: abort.signal });
    measure();
    return () => {
      abort.abort(); resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(pending);
      controls.current.forEach(release); controls.current = []; environment.dispose();
      // Declarative render resources are reused by StrictMode's effect replay.
    };
  }, [gl, resources]);

  useEffect(() => () => {
    resources.background.geometry.dispose(); resources.background.material.dispose(); resources.worldTarget.dispose();
  }, [resources]);

  useFrame((_, dt) => {
    const buffer = gl.getDrawingBufferSize(resources.buffer);
    if (resources.worldTarget.width !== buffer.x || resources.worldTarget.height !== buffer.y) {
      resources.worldTarget.setSize(buffer.x, buffer.y);
    }
    if (renderMain || !surfaceOutputs.get(gl)) {
      gl.setRenderTarget(resources.worldTarget); gl.render(scene, camera);
    }
    const image = !renderMain && surfaceOutputs.get(gl) || resources.worldTarget.texture;
    if (resources.background.material.map !== image) {
      resources.background.material.map = image; resources.background.material.needsUpdate = true;
    }
    gl.setRenderTarget(null);
    const autoClear = gl.autoClear, autoReset = gl.info.autoReset;
    try {
      const ease = 1 - Math.exp(-Math.min(dt, .1) * 16);
      const now = performance.now();
      controls.current.forEach(control => {
        const value = control.element.style.getPropertyValue('--water-pressure');
        const pressure = control.surface?0:value === '' ? waterPressure(control.element, now) : Number(value);
        const material=control.group.children[0].material;
        material.color.set(control.element.getAttribute('aria-pressed')==='true'||control.element.getAttribute('aria-expanded')==='true' ? '#cad5dd' : '#e4e8eb');
        material.thickness = (2 + depthRef.current * .65) * (1 - .55 * pressure);
        material.userData.wave.value=pressure*1.8+(Math.abs(control.tx)+Math.abs(control.ty))*5;
        material.userData.phase.value=now*.012;
        control.group.rotation.x = THREE.MathUtils.lerp(control.group.rotation.x, control.tx, ease);
        control.group.rotation.y = THREE.MathUtils.lerp(control.group.rotation.y, control.ty, ease);
        control.group.position.z = (control.surface?-30:0)-8 * pressure;
        control.group.position.y = control.baseY - 3 * pressure;
        control.group.scale.set(1 - .025 * pressure, 1 - .025 * pressure, (.35+depthRef.current*.012)*(1 - .6 * pressure));
        const shadow=waterShadow(pressure),uniforms=control.shadow.material.uniforms;
        control.shadow.position.set(control.baseX+shadow.x,control.baseY-3*pressure+shadow.y,control.surface?-65:-45);
        uniforms.offset.value.set(shadow.x,shadow.y);uniforms.softness.value=shadow.softness;uniforms.opacity.value=shadow.opacity;
        // Keep the blur canvas padded at its maximum size, only contract its footprint.
        uniforms.halfButton.value.set(control.width*shadow.scale/2,control.height*shadow.scale/2);
        if (!control.tx && Math.abs(control.group.rotation.x) < .0001) control.group.rotation.x = 0;
        if (!control.ty && Math.abs(control.group.rotation.y) < .0001) control.group.rotation.y = 0;
        control.group.visible = control.shadow.visible = !failed.current;
        if (!failed.current && control.element.dataset.optical !== 'ready') control.element.dataset.optical = 'ready';
      });
      // Keep diagnostics for the entire frame, including terrain and UI optics.
      gl.autoClear = true; gl.info.autoReset = false; gl.render(resources.hud, resources.view);
    } catch (error) {
      failed.current = true;
      controls.current.forEach(control => control.element.removeAttribute('data-optical'));
      console.warn('[liquid] Optical controls unavailable; native controls remain active.', error);
    } finally { gl.autoClear = autoClear; gl.info.autoReset = autoReset; }
  }, 2);
  return null;
}
