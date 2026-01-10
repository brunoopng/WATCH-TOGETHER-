// client.js — versão revisada Android ↔ iPhone compatível
// Suporte a TURN fallback, VP8/H264, playsinline, autoplay, fullscreen e qualidade
// Cole este arquivo em public/client.js

const roomIdInput = document.getElementById('roomId');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const fileInput = document.getElementById('fileInput');
const loadBtn = document.getElementById('loadBtn');
const startStreamBtn = document.getElementById('startStreamBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const unmuteBtn = document.getElementById('unmuteBtn');
const player = document.getElementById('player');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

let ws = null;
let myId = null;
let isHost = false;
let roomId = null;
const peers = new Map();
let outgoingStream = null;
const pendingPeers = new Set();

const handledOfferFingerprints = new Set();
const handledAnswersFrom = new Set();

function now() { return new Date().toISOString().slice(11,23); }
function log(...t) { logEl.innerText += (logEl.innerText? '\n' : '') + '['+now()+'] ' + t.join(' '); logEl.scrollTop = logEl.scrollHeight; console.log(...t); }
function setStatus(s){ statusEl.innerText = s; }

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const ICE_ENDPOINT = '/ice';

let qualityMode = 'auto';

// ----------------- UI Quality & Fullscreen -----------------
(function ensureQualityAndFullscreenUI(){
  let container = document.getElementById('controls') || document.body;
  if (!document.getElementById('qualitySelect')) {
    const wrap = document.createElement('div');
    wrap.style.display = 'inline-block';
    wrap.style.marginLeft = '12px';
    wrap.innerHTML = `
      <label style="font-size:12px; margin-right:6px;">Qualidade:</label>
      <select id="qualitySelect" title="Escolha qualidade do stream">
        <option value="auto">Auto (padrão)</option>
        <option value="high">Alta (720p)</option>
        <option value="ultra">Ultra (1080p)</option>
      </select>
      <button id="fsBtn" title="Fullscreen" style="margin-left:8px; display:none">⤢ Fullscreen</button>
    `;
    if (document.getElementById('startStreamBtn')) {
      document.getElementById('startStreamBtn').insertAdjacentElement('afterend', wrap);
    } else {
      container.appendChild(wrap);
    }
    document.getElementById('qualitySelect').addEventListener('change', (e)=>{ setQualityMode(e.target.value); });
    const fsBtn = document.getElementById('fsBtn');
    fsBtn.addEventListener('click', ()=>toggleFullScreen());
    player.addEventListener('dblclick', ()=>toggleFullScreen());
  }
})();

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    player.requestFullscreen().catch(()=>{});
  } else {
    document.exitFullscreen().catch(()=>{});
  }
}

// ----------------- Canvas capture fallback -----------------
function createCanvasCaptureFromPlayer(targetWidth=1280, targetHeight=720, fps=30){
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.style.display='none';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let rafId = null;
  const draw = ()=>{ try{ ctx.drawImage(player,0,0,canvas.width,canvas.height);}catch(e){} rafId=requestAnimationFrame(draw); };
  rafId=requestAnimationFrame(draw);

  const stream = canvas.captureStream(fps);
  const stopAll = ()=>{
    if(rafId){ cancelAnimationFrame(rafId); rafId=null; }
    setTimeout(()=>{ try{ canvas.remove(); }catch(e){} },1000);
  };
  stream._stopCanvas = stopAll;
  stream.getTracks().forEach(t=>t.addEventListener('ended',stopAll));
  return { stream, stop: stopAll, canvas };
}

// ----------------- Forçar VP8/H264 no SDP -----------------
function preferCodec(sdp, codec='VP8'){
  const lines = sdp.split('\r\n');
  const mLineIndex = lines.findIndex(l=>l.startsWith('m=video'));
  if(mLineIndex===-1) return sdp;
  const codecRegex = new RegExp(`a=rtpmap:(\\d+) ${codec}/\\d+`, 'i');
  const codecPayload = lines.map(l=>l.match(codecRegex)).filter(Boolean).map(m=>m[1])[0];
  if(!codecPayload) return sdp;
  const mLineParts = lines[mLineIndex].split(' ');
  const newMLine=[mLineParts[0],mLineParts[1],mLineParts[2],codecPayload,...mLineParts.slice(3).filter(p=>p!==codecPayload)].join(' ');
  lines[mLineIndex]=newMLine;
  return lines.join('\r\n');
}

// ----------------- Boost bitrate -----------------
async function boostSenderParameters(pc, bitrate=1500000){
  try{
    const sender=pc.getSenders().find(s=>s.track && s.track.kind==='video');
    if(!sender||!sender.getParameters) return false;
    const params=sender.getParameters();
    if(!params.encodings||!params.encodings.length) params.encodings=[{}];
    params.encodings[0].maxBitrate=bitrate;
    params.encodings[0].maxFramerate=30;
    params.encodings[0].scaleResolutionDownBy=1.0;
    await sender.setParameters(params);
    return true;
  }catch(e){ console.warn('boostSenderParameters failed',e); return false; }
}

// ----------------- Quality / Stream renegotiate -----------------
async function applyQualityToPeers(newMode){
  let newStream=null, canvasController=null;
  const isSafari = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome');
  if(newMode==='ultra'){ ({ stream:newStream, stop:canvasController } = createCanvasCaptureFromPlayer(1920,1080,30)); }
  else if(newMode==='high'){ ({ stream:newStream, stop:canvasController } = createCanvasCaptureFromPlayer(1280,720,30)); }
  else{
    if(!isSafari && typeof player.captureStream==='function'){ newStream=player.captureStream(); }
    else if(isSafari){ ({ stream:newStream, stop:canvasController } = createCanvasCaptureFromPlayer(1280,720,30)); }
  }
  if(!newStream){ log('Nao foi possivel criar stream para qualidade', newMode); return; }
  const oldStream = outgoingStream;
  outgoingStream=newStream;
  outgoingStream._canvasController=canvasController||null;
  const bitrateMap={ auto:600000, high:1500000, ultra:3500000 };
  const targetBitrate=bitrateMap[newMode]||1500000;
  for(const pid of Array.from(peers.keys())){
    const entry=peers.get(pid);
    if(!entry) continue;
    const pc=entry.pc;
    for(const track of outgoingStream.getTracks()){
      const sender=pc.getSenders().find(s=>s.track && s.track.kind===track.kind);
      if(sender) try{ await sender.replaceTrack(track); }catch(e){ console.warn('replaceTrack fail',e);}
      else try{ pc.addTrack(track,outgoingStream); }catch(e){ console.warn('addTrack fail',e);}
    }
    await boostSenderParameters(pc,targetBitrate).catch(()=>{});
    try{
      let offer=await pc.createOffer();
      offer.sdp=preferCodec(offer.sdp,'VP8');
      await pc.setLocalDescription(offer);
      const fp=(offer.sdp||'').slice(0,120);
      sendWS({ type:'offer', to:pid, from:myId, roomId, sdp:pc.localDescription, offerFingerprint:fp });
    }catch(e){ console.warn('reneg fail',e);}
  }
  if(oldStream && oldStream!==newStream){
    try{ oldStream.getTracks().forEach(t=>{ try{t.stop();}catch(e){} }); if(oldStream._stopCanvas) oldStream._stopCanvas(); }catch(e){}
  }
}

// ----------------- Set Quality -----------------
async function setQualityMode(mode){
  if(!['auto','high','ultra'].includes(mode)) return;
  qualityMode=mode;
  const sel=document.getElementById('qualitySelect'); if(sel) sel.value=mode;
  log('Modo de qualidade definido para',mode);
  if(isHost && outgoingStream) await applyQualityToPeers(mode);
}

// ----------------- ICE fetch com fallback TURN/STUN -----------------
let ICE_CACHE={ expires:0, iceServers:[{urls:'stun:stun.l.google.com:19302'}] };
let ICE_FETCH_PROMISE=null;
async function fetchIceServers(force=false){
  const nowTs=Date.now();
  if(!force && ICE_CACHE.expires>nowTs && ICE_CACHE.iceServers) return ICE_CACHE.iceServers;
  if(ICE_FETCH_PROMISE) return ICE_FETCH_PROMISE;
  ICE_FETCH_PROMISE=(async ()=>{
    try{
      const res=await fetch(ICE_ENDPOINT,{cache:'no-store'});
      if(!res.ok) throw new Error('ICE fail '+res.status);
      const data=await res.json();
      const ice=(data && data.v && data.v.iceServers)? data.v.iceServers : (data && data.iceServers)?data.iceServers: (Array.isArray(data)?data:null);
      if(ice && ice.length){ ICE_CACHE.iceServers=ice; ICE_CACHE.expires=Date.now()+60000; log('ICE servers obtidos do backend'); return ice; }
      throw new Error('ICE inválido do backend');
    }catch(err){
      console.warn('fetchIceServers fail, usando fallback STUN/TURN',err);
      ICE_CACHE.iceServers=[
        {urls:'stun:stun.l.google.com:19302'},
        {urls:'turn:turn.anyfirewall.com:443?transport=tcp', username:'webrtc', credential:'webrtc'}
      ];
      ICE_CACHE.expires=Date.now()+60000;
      return ICE_CACHE.iceServers;
    }finally{ ICE_FETCH_PROMISE=null; }
  })();
  return ICE_FETCH_PROMISE;
}

// ----------------- WebSocket -----------------
function connectWS(){
  if(ws && ws.readyState===WebSocket.OPEN) return;
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{ setStatus('conectado'); log('WS conectado'); };
  ws.onmessage=(e)=>{ try{ handleWS(JSON.parse(e.data)); }catch(err){ console.warn('WS parse fail',err); } };
  ws.onclose=()=>{ setStatus('desconectado'); log('WS fechado'); };
  ws.onerror=(e)=>console.warn('WS error',e);
}
function sendWS(obj){ if(!ws||ws.readyState!==WebSocket.OPEN){ log('WS nao conectado'); return; } ws.send(JSON.stringify(obj)); }

// ----------------- Create / Join -----------------
createBtn.onclick=()=>{
  connectWS();
  roomId=roomIdInput.value.trim()||('room-'+Math.random().toString(36).slice(2,6));
  sendWS({ type:'create', roomId });
  isHost=true;
  log('Criou sala',roomId);
};
joinBtn.onclick=()=>{
  connectWS();
  roomId=roomIdInput.value.trim();
  if(!roomId) return alert('Digite o ID da sala');
  sendWS({ type:'join', roomId });
  isHost=false;
  log('Entrando na sala',roomId);
  player.pause(); player.src=''; player.srcObject=null; player.controls=false;
};

// ----------------- Load File -----------------
loadBtn.onclick=()=>{
  if(!isHost) return alert('Somente host pode carregar o vídeo');
  const f=fileInput.files[0];
  if(!f) return alert('Escolha um arquivo de vídeo');
  const url=URL.createObjectURL(f);
  player.srcObject=null;
  player.src=url;
  player.muted=true;
  player.play().catch(()=>{});
  log('Arquivo carregado (host). Use "Iniciar stream" para transmitir.');
};

// ----------------- Start Stream -----------------
startStreamBtn.onclick=async()=>{
  if(!isHost) return alert('Somente host pode iniciar o stream');
  if(!player.src && !player.srcObject) return alert('Carregue um vídeo antes');
  try{ await player.play(); }catch(e){ console.warn('player.play failed',e); }
  const isSafari = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome');
  if(qualityMode==='ultra') outgoingStream=createCanvasCaptureFromPlayer(1920,1080,30).stream;
  else if(qualityMode==='high') outgoingStream=createCanvasCaptureFromPlayer(1280,720,30).stream;
  else if(!isSafari && typeof player.captureStream==='function') outgoingStream=player.captureStream();
  else outgoingStream=createCanvasCaptureFromPlayer(1280,720,30).stream;

  const toNegotiate=Array.from(new Set([...peers.keys(), ...pendingPeers]));
  pendingPeers.clear();
  for(const pid of toNegotiate){
    if(!peers.has(pid)) await createPC(pid,false);
    const pc=peers.get(pid).pc;
    for(const track of outgoingStream.getTracks()){
      const sender=pc.getSenders().find(s=>s.track && s.track.kind===track.kind);
      if(sender) try{ await sender.replaceTrack(track); }catch(e){ console.warn('replaceTrack fail',e);}
      else try{ pc.addTrack(track,outgoingStream); }catch(e){ console.warn('addTrack fail',e);}
    }
    await boostSenderParameters(pc,{ auto:600000, high:1500000, ultra:3500000 }[qualityMode]||1500000);
    try{ let offer=await pc.createOffer(); offer.sdp=preferCodec(offer.sdp,'VP8'); await pc.setLocalDescription(offer);
      const fp=(offer.sdp||'').slice(0,120); sendWS({ type:'offer', to:pid, from:myId, roomId, sdp:pc.localDescription, offerFingerprint:fp }); }catch(e){ console.warn('reneg fail',e);}
  }
  const vt=outgoingStream.getVideoTracks()[0];
  if(vt) vt.onended=()=>{ log('Stream finalizado pelo host'); sendWS({ type:'screen-stopped', roomId }); outgoingStream=null; };
};

// ----------------- Play / Pause / Unmute -----------------
playBtn.onclick=async()=>{
  if(!isHost) return;
  try{ await player.play(); }catch(e){ console.warn(e); }
  if(!outgoingStream && typeof player.captureStream==='function') outgoingStream=player.captureStream();
  sendWS({ type:'play', roomId, time:player.currentTime });
};
pauseBtn.onclick=()=>{ if(!isHost) return; player.pause(); sendWS({ type:'pause', roomId, time:player.currentTime }); };
unmuteBtn.onclick=()=>{ player.muted=false; unmuteBtn.style.display='none'; };

// ----------------- Handle WebSocket -----------------
async function handleWS(msg){
  const type=msg.type;
  if(type==='created'){ myId=msg.id; log('Você é host id',myId); return; }
  if(type==='joined'){ myId=msg.id; log('Entrou com id',myId); return; }
  if(type==='new-peer' && isHost){
    log('Novo peer entrou:',msg.id);
    await createPC(msg.id,false);
    if(outgoingStream){
      const pc=peers.get(msg.id).pc;
      for(const track of outgoingStream.getTracks()){
        const sender=pc.getSenders().find(s=>s.track && s.track.kind===track.kind);
        if(sender) try{ await sender.replaceTrack(track); }catch(e){}
        else try{ pc.addTrack(track,outgoingStream); }catch(e){}
      }
      let offer=await pc.createOffer(); offer.sdp=preferCodec(offer.sdp,'VP8'); await pc.setLocalDescription(offer);
      sendWS({ type:'offer', to:msg.id, from:myId, roomId, sdp:pc.localDescription, offerFingerprint:(offer.sdp||'').slice(0,120) });
      log('Offer enviada para',msg.id);
    } else pendingPeers.add(msg.id);
    return;
  }

  if(type==='offer' && !isHost){
    const fid=msg.from; const fp=msg.offerFingerprint||((msg.sdp&&msg.sdp.sdp)?msg.sdp.sdp.slice(0,120):null);
    if(fp && handledOfferFingerprints.has(fp)){ log('Offer duplicado ignorado',fid); return; }
    if(fp) handledOfferFingerprints.add(fp);
    log('Guest: recebendo offer do host',fid);
    await createPC(fid,false);
    const entry=peers.get(fid);
    try{
      await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      let answer=await entry.pc.createAnswer(); answer.sdp=preferCodec(answer.sdp,'VP8');
      await entry.pc.setLocalDescription(answer);
      sendWS({ type:'answer', to:msg.from, from:myId, roomId, sdp:entry.pc.localDescription });
      log('Guest: Answer enviada ao host');
    }catch(e){ console.warn('Guest handle offer fail',e);}
    return;
  }

  if(type==='answer' && isHost){
    const from=msg.from;
    if(handledAnswersFrom.has(from)){ log('Answer duplicada de',from,'ignorando'); return; }
    handledAnswersFrom.add(from);
    const entry=peers.get(from);
    if(entry) try{ await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); log('Answer set de',from); }catch(e){ console.warn('setRemoteDescription fail',e);}
    else log('Answer de',from,'mas pc nao existe ainda');
    return;
  }

  if(type==='ice'){
    const from=msg.from; const candidate=msg.candidate;
    if(peers.has(from)){ try{ await peers.get(from).pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){ console.warn('ice add fail',e);} }
    else for(const entry of peers.values()){ try{ await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){} }
    return;
  }

  if(!
