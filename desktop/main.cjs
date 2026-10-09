const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('force_high_performance_gpu');
app.setName('BHUVAN');
app.setPath('userData', path.join(__dirname,'.profile'));
const reviewOnly=process.env.BHUVAN_GPU_VERIFY_ONLY==='1';
const url=process.env.BHUVAN_DESKTOP_URL||'http://127.0.0.1:5173/';
if(!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url))throw new Error('Desktop launcher accepts a local BHUVAN origin only.');
const proofPath=path.join(__dirname,'gpu-verification.json');
const logPath=path.join(__dirname,'runtime.log');
const log=message=>fs.appendFileSync(logPath,new Date().toISOString()+' '+message+'\n');
app.whenReady().then(async()=> {
  log('Desktop ready; verification-only='+reviewOnly);
  const window = new BrowserWindow({width:1360,height:900,show:!reviewOnly,title:'BHUVAN · NVIDIA workspace',
    backgroundColor:'#060b13',autoHideMenuBar:true,
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.once('ready-to-show',()=> {if(!reviewOnly)window.show();});
  if(!reviewOnly)window.show();
  window.webContents.on('did-fail-load',(_event,code,description)=>log('Load failed '+code+' '+description));
  window.webContents.on('render-process-gone',(_event,details)=>log('Renderer stopped '+JSON.stringify(details)));
  window.webContents.setWindowOpenHandler(({url:destination})=> {
    if(/^https:\/\//.test(destination))shell.openExternal(destination);
    return {action:'deny'};
  });
  window.webContents.on('will-navigate',(event,destination)=> {if(new URL(destination).origin!==new URL(url).origin)event.preventDefault();});
  window.webContents.on('console-message',async(_event,details,legacyMessage)=> {
    const message=typeof details==='object'?details.message:legacyMessage;
    if(message)log(message);
    if(!message?.startsWith('[bhuvan-client-gpu] '))return;
    try {
      const renderer=JSON.parse(message.slice('[bhuvan-client-gpu] '.length));
      const gpu=await app.getGPUInfo('complete');
      const proof={timestamp:new Date().toISOString(),renderer,gpu,requested:'force_high_performance_gpu',verifiedNvidia:renderer.nvidia&&!renderer.software};
      fs.writeFileSync(proofPath,JSON.stringify(proof,null,2));
      if(!proof.verifiedNvidia && !reviewOnly) {
        // Strict local launcher refuses to keep running the 3D application on
        // Intel/SwiftShader. Ordinary deployed web clients remain portable.
        await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="background:#08121a;color:#d7eef5;font:18px system-ui;padding:48px"><h1>NVIDIA rendering was not selected</h1><p>BHUVAN stopped its 3D view. Open Windows Settings → System → Display → Graphics, select this project’s Electron executable and choose High performance, then relaunch.</p><p>Renderer: '+renderer.renderer.replace(/[<>&]/g,'')+'</p></body>'));
      }
      if(reviewOnly)app.quit();
    } catch(error) {fs.writeFileSync(proofPath,JSON.stringify({error:String(error)},null,2));if(reviewOnly)app.quit();}
  });
  await window.loadURL(url);
  log('Local workspace loaded');
  const startupGpu=await app.getGPUInfo('complete');
  const startupRenderer=startupGpu.auxAttributes?.glRenderer||'';
  const verifiedStartupNvidia=/nvidia/i.test(startupRenderer)&&!/(swiftshader|llvmpipe|software)/i.test(startupRenderer);
  fs.writeFileSync(path.join(__dirname,'gpu-startup-verification.json'),JSON.stringify({timestamp:new Date().toISOString(),renderer:startupRenderer,
    activeDevices:startupGpu.gpuDevice?.filter(device=>device.active),featureStatus:app.getGPUFeatureStatus(),verifiedNvidia:verifiedStartupNvidia},null,2));
  log('Startup graphics renderer: '+startupRenderer);
  if(!verifiedStartupNvidia&&!reviewOnly)await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<body style="background:#08121a;color:#d7eef5;font:18px system-ui;padding:48px"><h1>NVIDIA rendering was not selected</h1><p>The 3D workspace stopped. Select High performance for this project’s Electron executable in Windows Graphics settings and relaunch.</p></body>'));
  if(reviewOnly)setTimeout(()=>app.quit(),20000);
});
app.on('window-all-closed',()=>app.quit());
