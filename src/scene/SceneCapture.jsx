import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { embedCaptureMetadata } from '../engine/captureMetadata';

function download(blob,name) {
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
}
export default function SceneCapture({sceneId,active=true,analysis,runtime,verticalExaggeration=1}) {
  const {gl,camera,scene}=useThree(),request=useRef(false);
  useEffect(()=> {
    const capture=e=>{if(active&&e.detail===sceneId)request.current=true;};
    window.addEventListener('bhuvan-capture-frame',capture);return()=>window.removeEventListener('bhuvan-capture-frame',capture);
  },[active,sceneId]);
  // After the main scene and water lenses have rendered, before buffer clearing.
  useFrame(()=> {
    if(!request.current)return;request.current=false;
    const p=analysis?.metadata?.provenance;
    const metadata={kind:'simulated camera frame; not a satellite observation or orthophoto',scene:sceneId,
      capturedAt:new Date().toISOString(),jobId:analysis?.jobId||null,dataset:p?.dataset_id||null,reference:p?.reference||null,
      sourceSpacingM:p?.source_gsd||null,analysisSpacingM:p?.analysis_gsd||null,
      cameraCoordinates:sceneId==='orbit'?'compressed visual world; not a body-fixed physical position':'dataset-local X south, Z east; Y is visually exaggerated DEM-relative height',verticalExaggeration,
      cameraPosition:camera.position.toArray(),cameraQuaternion:camera.quaternion.toArray(),projectionMatrix:camera.projectionMatrix.toArray(),
      roverPosition:runtime?.current?.position||null,terrainSource:analysis?.metadata?.colorUrl||null,
      limitation:'Perspective colour alone cannot determine elevation. Reuse the measured DEM; acquire registered stereo/lidar for new heights.'};
    // A simulated camera image excludes the UI optics, which share this canvas.
    const autoClear=gl.autoClear;gl.autoClear=true;gl.setRenderTarget(null);gl.render(scene,camera);gl.autoClear=autoClear;
    gl.domElement.toBlob(async blob=> {
      if(!blob){window.dispatchEvent(new CustomEvent('bhuvan-capture-result',{detail:'Capture unavailable. Try again after terrain loads.'}));return;}
      try {
        const png=embedCaptureMetadata(new Uint8Array(await blob.arrayBuffer()),metadata);
        download(new Blob([png],{type:'image/png'}),`bhuvan-${sceneId}-frame.png`);
        window.dispatchEvent(new CustomEvent('bhuvan-capture-result',{detail:'Simulated frame saved. Camera and dataset metadata are embedded in the PNG; it is not a new measured DEM.'}));
      } catch(error) {window.dispatchEvent(new CustomEvent('bhuvan-capture-result',{detail:`Capture failed: ${error.message}`}));}
    },'image/png');
  },3);
  return null;
}
