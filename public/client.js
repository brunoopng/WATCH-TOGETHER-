// client.js — versão integrada com patches para iPhone/Safari
// Mantém funcionalidades originais: TURN via backend (/ice), Quality (720p/1080p), Fullscreen,
// mas adapta captureStream/SDP/ICE/autoplay para compatibilidade Android <-> iPhone.

// ---------------------------------------------
// Elementos UI
// ---------------------------------------------
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
const peers = new Map(); // peerId -> { pc, dc }
let outgoingStream = null; // captureStream from player when host plays
const pendingPeers = new Set(); // peers that joined before stream ready

// dedupe
const handledOfferFingerprints = new Set();
const handledAnswersFrom = new Set();

function now(){ return new Date().toISOString().slice(11,23); }
function log(...t){ logEl.innerText += (logEl.innerText? '\n' : '') + '['+now()+'] ' + t.join(' '); logEl.scrollTop = logEl.scrollHeight; console.log(...t); }
function setStatus(s){ statusEl.innerText = s; }

const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const ICE_ENDPOINT = '/ice'; // endpoint backend que retorna iceServers

// ----------------- iOS / Safari detection & SDP helper -----------------
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// preferir codecs: tenta uma lista na ordem passada (ex: ['VP8','H264'])
function preferCodec(sdp, codecPriority = ['VP8','H264']) {
  if (!sdp) return sdp;
  const lines = sdp.split('\r\n');
  const mLineIndex = lines.findIndex(l => l.startsWith('m=video'));
  if (mLineIndex === -1) return sdp;
  for (const codec of codecPriority) {
    const regex = new RegExp(`a=rtpmap:(\\d+) ${codec}/\\d+`, 'i');
    const found = lines.map(l => l.match(regex)).filter(Boolean)[0];
    if (found) {
      const payload = found[1];
      const parts = lines[mLineIndex].split(' ');
      // reorder payloads putting chosen payload first
      const newM = [parts[0], parts[1], parts[2], payload, ...parts.slice(3).filter(p => p !== payload)].join(' ');
      lines[mLineIndex] = newM;
      return lines.join('\r\n');
    }
  }
  return sdp;
}

// ----------------- QUALITY UI / CANVAS / BITRATE / FULLSCREEN -----------------
let qualityMode = 'auto'; // 'auto' | 'high' | 'ultra'

// cria UI de seleção de qualidade e botão de fullscreen (se não existir)
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
    const sel = document.getElementById('qualitySelect');
    sel.addEventListener('change', (e) => { setQualityMode(e.target.value); });

    const fsBtn = document.getElementById('fsBtn');
    fsBtn.addEventListener('click', () => toggleFullScreen());
    // double click on player toggles fullscreen (counts as user gesture)
    player.addEventListener('dblclick', () => toggleFullScreen());
  }
})();

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    if (player.requestFullscreen) player.requestFullscreen().catch(()=>{});
    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}

// createCanvasCaptureFromPlayer: desenha o vídeo em um canvas na resolução desejada
function createCanvasCaptureFromPlayer(targetWidth = 1280, targetHeight = 720, fps = 30) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let rafId = null;
  const draw = () => {
    try { ctx.drawImage(player, 0, 0, canvas.width, canvas.height); } catch (e) {}
    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);

  const stream = canvas.captureStream(fps);
  const stopAll = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    setTimeout(()=> { try { canvas.remove(); } catch(e){} }, 1000);
  };
  stream._stopCanvas = stopAll;
  stream.getTracks().forEach(t => t.addEventListener('ended', stopAll));
  return { stream, stop: stopAll, canvas };
}

// tenta aplicar parâmetros de bitrate ao sender de vídeo
async function boostSenderParameters(pc, bitrate = 1500000) {
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender || !sender.getParameters) return false;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = typeof bitrate === 'number' ? bitrate : (bitrate.auto || bitrate.high || bitrate.ultra || 1500000);
    params.encodings[0].maxFramerate = 30;
    params.encodings[0].scaleResolutionDownBy = 1.0;
    await sender.setParameters(params);
    console.log('Sender params applied: ', params.encodings[0].maxBitrate);
    return true;
  } catch (e) {
    console.warn('boostSenderParameters failed', e);
    return false;
  }
}

// aplica qualidade escolhida (auto/720/1080) com renegociação
async function applyQualityToPeers(newMode) {
  let newStream = null, canvasController = null;
  const safari = isSafari;

  if (newMode === 'ultra') {
    try {
      const { stream, stop } = createCanvasCaptureFromPlayer(1920, 1080, 30);
      newStream = stream;
      canvasController = { stop };
    } catch(e) { console.warn('criar canvas 1080p falhou', e); }
  } else if (newMode === 'high') {
    const { stream, stop } = createCanvasCaptureFromPlayer(1280, 720, 30);
    newStream = stream; canvasController = { stop };
  } else {
    if (!safari && typeof player.captureStream === 'function') {
      try { newStream = player.captureStream(); } catch(e){ console.warn('player.captureStream fail', e); newStream = null; }
    }
    if (!newStream) {
      // Safari or captureStream unavailable -> canvas fallback
      try { const { stream, stop } = createCanvasCaptureFromPlayer(1280,720,30); newStream = stream; canvasController = { stop }; log('Usando canvas fallback ao aplicar qualidade.'); } catch(e){ console.warn('canvas fallback fail', e); }
    }
    if (!newStream && outgoingStream) newStream = outgoingStream;
  }

  if (!newStream) { log('Nao foi possivel criar novo stream para qualidade ' + newMode); return; }

  const oldStream = outgoingStream;
  outgoingStream = newStream;
  outgoingStream._canvasController = canvasController || null;

  const bitrateMap = { auto: 600000, high: 1500000, ultra: 3500000 };
  const targetBitrate = bitrateMap[newMode] || 1500000;

  const peerIds = Array.from(peers.keys());
  for (const pid of peerIds) {
    const entry = peers.get(pid);
    if (!entry) continue;
    const pc = entry.pc;

    for (const track of outgoingStream.getTracks()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
      if (sender) {
        try { await sender.replaceTrack(track); } catch(e){ console.warn('replaceTrack fail', e); }
      } else {
        try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn('addTrack fail', e); }
      }
    }

    await boostSenderParameters(pc, targetBitrate).catch(()=>{});

    try {
      let offer = await pc.createOffer();
      offer.sdp = preferCodec(offer.sdp, ['VP8','H264']);
      await pc.setLocalDescription(offer);
      const fp = (offer.sdp || '').slice(0,120);
      sendWS({ type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
      log('Renegociação (offer) enviada para', pid, 'modo', newMode);
    } catch (e) { console.warn('reneg fail', e); }
  }

  if (oldStream && oldStream !== newStream) {
    try {
      oldStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
      if (oldStream._stopCanvas) try { oldStream._stopCanvas(); } catch(e){}
    } catch(e){}
  }
}

// setQualityMode atualizada (chama applyQualityToPeers se host já estiver transmitindo)
async function setQualityMode(mode) {
  if (!['auto','high','ultra'].includes(mode)) return;
  qualityMode = mode;
  const sel = document.getElementById('qualitySelect');
  if (sel) sel.value = mode;
  log('Modo de qualidade definido para', mode);

  if (isHost && outgoingStream) {
    log('Aplicando nova qualidade aos peers:', mode);
    await applyQualityToPeers(mode);
  }
}

// substitui startStream handler para respeitar qualidade escolhida
const originalStartStreamHandler = startStreamBtn.onclick;
startStreamBtn.onclick = async function wrappedStartStreamHandler(evt) {
  try {
    if (!isHost) return alert('Somente host pode iniciar o stream');
    if (!player.src && !player.srcObject) return alert('Carregue um vídeo antes');
    // iOS/Safari exige interação do usuário: este handler é um clique -> seguro chamar play()
    try { await player.play(); } catch(e){ console.warn('play failed', e); }

    const safari = isSafari;

    if (qualityMode === 'ultra') {
      try {
        const { stream, stop } = createCanvasCaptureFromPlayer(1920, 1080, 30);
        outgoingStream = stream;
        outgoingStream._stopCanvas = stop;
        log('Usando canvas capture para qualidade ULTRA (1080p@30).');
      } catch (e) {
        console.warn('Falha canvas 1080p, fallback:', e);
        if (!safari && typeof player.captureStream === 'function') outgoingStream = player.captureStream();
      }
    } else if (qualityMode === 'high') {
      try {
        const { stream, stop } = createCanvasCaptureFromPlayer(1280, 720, 30);
        outgoingStream = stream; outgoingStream._stopCanvas = stop;
        log('Usando canvas capture para qualidade HIGH (720p@30).');
      } catch (e) {
        console.warn('Falha canvas 720p, fallback:', e);
        if (!safari && typeof player.captureStream === 'function') outgoingStream = player.captureStream();
      }
    } else {
      if (!safari && typeof player.captureStream === 'function') {
        try { outgoingStream = player.captureStream(); log('Usando player.captureStream() (modo AUTO).'); } catch(e){ console.warn('captureStream fail', e); outgoingStream = null; }
      }
      if (!outgoingStream) {
        // Safari ou captureStream indisponível -> canvas fallback (necessário pois muitos iOS não suportam captureStream em blobs)
        try { const { stream, stop } = createCanvasCaptureFromPlayer(1280,720,30); outgoingStream = stream; outgoingStream._stopCanvas = stop; log('Safari/fallback: usando canvas capture (AUTO).'); } catch(e){ console.warn('canvas fallback fail', e); }
      }
    }

    if (!outgoingStream) {
      alert('Nao foi possivel criar stream de vídeo (captureStream/canvas falharam). Tente outro navegador.');
      return;
    }

    const toNegotiate = Array.from(new Set([...peers.keys(), ...pendingPeers]));
    pendingPeers.clear();
    for (const pid of toNegotiate) {
      const entry = peers.get(pid);
      if (!entry) {
        log('Criando PC para', pid, 'antes da negociação');
        await createPC(pid, false);
      }
      const pc = peers.get(pid).pc;
      for (const track of outgoingStream.getTracks()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
        if (sender) {
          try { await sender.replaceTrack(track); } catch(e){ console.warn('replaceTrack fail', e); }
        } else {
          try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn('addTrack fail', e); }
        }
      }
      const brMap = { auto: 600000, high: 1500000, ultra: 3500000 };
      await boostSenderParameters(pc, brMap[qualityMode] || 1500000).catch(()=>{});
      try {
        let offer = await pc.createOffer();
        offer.sdp = preferCodec(offer.sdp, ['VP8','H264']);
        await pc.setLocalDescription(offer);
        const fp = (offer.sdp || '').slice(0,120);
        sendWS({ type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
        log('Offer (com tracks) enviada para', pid);
      } catch(err){ console.warn('reneg fail', err); }
    }

    const vt = outgoingStream.getVideoTracks()[0];
    if (vt) vt.onended = () => { log('Stream finalizado pelo host'); sendWS({ type:'screen-stopped', roomId }); outgoingStream = null; };

  } catch (err) {
    console.warn('Erro no wrappedStartStreamHandler', err);
  }

  try { if (typeof originalStartStreamHandler === 'function') originalStartStreamHandler.call(this, evt); } catch(e){}
};
// ---------------------------------------------------------------------------

// ICE cache/refresh helper
let ICE_CACHE = { expires: 0, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let ICE_FETCH_PROMISE = null;
async function fetchIceServers(force=false) {
  const nowTs = Date.now();
  if (!force && ICE_CACHE.expires > nowTs && ICE_CACHE.iceServers) {
    return ICE_CACHE.iceServers;
  }
  if (ICE_FETCH_PROMISE) return ICE_FETCH_PROMISE; // dedupe concurrent fetches
  ICE_FETCH_PROMISE = (async () => {
    try {
      const res = await fetch(ICE_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) throw new Error('ICE endpoint fail ' + res.status);
      const data = await res.json();
      const ice = (data && data.v && data.v.iceServers) ? data.v.iceServers
                : (data && data.iceServers) ? data.iceServers
                : (Array.isArray(data) ? data : null);

      if (ice && ice.length) {
        ICE_CACHE.iceServers = ice;
        ICE_CACHE.expires = Date.now() + (60 * 1000); // 60s cache
        log('ICE servers obtidos do backend (cache por 60s)');
        return ice;
      } else {
        throw new Error('ICE servers inválidos do backend');
      }
    } catch (err) {
      console.warn('fetchIceServers fail, usando fallback STUN/TURN', err);
      // fallback: STUN público + TURN de teste (bom para debug; para produção coloque seu TURN)
      ICE_CACHE.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:turn.anyfirewall.com:443?transport=tcp', username: 'webrtc', credential: 'webrtc' }
      ];
      ICE_CACHE.expires = Date.now() + (60 * 1000);
      return ICE_CACHE.iceServers;
    } finally {
      ICE_FETCH_PROMISE = null;
    }
  })();
  return ICE_FETCH_PROMISE;
}

// WebSocket helper
function connectWS(){
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { setStatus('conectado'); log('WS conectado'); };
  ws.onmessage = (e) => { try{ handleWS(JSON.parse(e.data)); } catch(err){ console.warn('WS parse fail', err); } };
  ws.onclose = () => { setStatus('desconectado'); log('WS fechado'); };
  ws.onerror = (e) => console.warn('WS error', e);
}

function sendWS(obj){ if (!ws || ws.readyState !== WebSocket.OPEN){ log('WS nao conectado'); return; } ws.send(JSON.stringify(obj)); }

// create/join
createBtn.onclick = () => {
  connectWS();
  roomId = roomIdInput.value.trim() || ('room-' + Math.random().toString(36).slice(2,6));
  sendWS({ type:'create', roomId });
  isHost = true;
  log('Criou sala', roomId);
};
joinBtn.onclick = () => {
  connectWS();
  roomId = roomIdInput.value.trim();
  if (!roomId) return alert('Digite o ID da sala');
  sendWS({ type:'join', roomId });
  isHost = false;
  log('Entrando na sala', roomId);
  player.pause(); player.src = ''; player.srcObject = null; player.controls = false;
};

// load local file into player (host)
loadBtn.onclick = () => {
  if (!isHost) return alert('Somente o host pode carregar o vídeo');
  const f = fileInput.files[0];
  if (!f) return alert('Escolha um arquivo de vídeo');
  const url = URL.createObjectURL(f);
  player.srcObject = null;
  player.src = url;
  player.muted = true;
  // não confiar que play() funcionará automaticamente em todos os navegadores; mas tentamos (host clicar no botão é ok)
  player.play().catch(()=>{});
  log('Arquivo carregado (host). Use "Iniciar stream" para transmitir.');
};

// NOTE: startStreamBtn.onclick foi substituído acima pelo wrappedStartStreamHandler

// playBtn: adaptado para guest autoplay fallback + host behavior
playBtn.onclick = async () => {
  if (isHost) {
    try { await player.play(); } catch(e){ console.warn('player.play failed', e); }
    if (!outgoingStream && !isSafari && typeof player.captureStream === 'function') {
      try { outgoingStream = player.captureStream(); log('captureStream() criado no play'); } catch(e){ console.warn(e); }
    }
    sendWS({ type:'play', roomId, time: player.currentTime });
  } else {
    // convidado: clique do usuário -> tenta tocar
    try {
      await player.play();
      playBtn.style.display = 'none';
      log('Guest: play iniciado por clique do usuário');
    } catch (e) {
      log('Guest: play falhou mesmo após clique', e);
    }
  }
};

pauseBtn.onclick = () => { if (!isHost) return; player.pause(); sendWS({ type:'pause', roomId, time: player.currentTime }); };

unmuteBtn.onclick = () => { player.muted = false; unmuteBtn.style.display = 'none'; };

// handle incoming messages robustly
async function handleWS(msg){
  const type = msg.type;

  if (type === 'created') { myId = msg.id; log('Você é host id', myId); return; }
  if (type === 'joined') { myId = msg.id; log('Entrou com id', myId); return; }

  if (type === 'new-peer' && isHost) {
    log('Novo peer entrou:', msg.id);
    await createPC(msg.id, false);
    if (outgoingStream) {
      log('Stream já ativo — negociando agora com', msg.id);
      const pc = peers.get(msg.id).pc;
      for (const track of outgoingStream.getTracks()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
        if (sender) {
          try { await sender.replaceTrack(track); } catch(e){ console.warn('replaceTrack fail', e); }
        } else {
          try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn('addTrack fail', e); }
        }
      }
      try {
        let offer = await pc.createOffer();
        offer.sdp = preferCodec(offer.sdp, ['VP8','H264']);
        await pc.setLocalDescription(offer);
        const fp = (offer.sdp || '').slice(0,120);
        sendWS({ type:'offer', to: msg.id, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
        log('Offer (com tracks) enviada para', msg.id);
      } catch(e){ console.warn(e); }
    } else {
      pendingPeers.add(msg.id);
      log('Peer adicionado à fila pending — aguardando stream');
    }
    return;
  }

  if (type === 'offer' && isHost) {
    log('Host recebeu offer (ignorando) de', msg.from);
    return;
  }

  if (type === 'offer' && !isHost) {
    const fid = msg.from;
    const fp = msg.offerFingerprint || (msg.sdp && msg.sdp.sdp ? msg.sdp.sdp.slice(0,120) : null);
    if (fp && handledOfferFingerprints.has(fp)) {
      log('Offer duplicado ignorado por fingerprint de', fid);
      return;
    }
    if (fp) handledOfferFingerprints.add(fp);
    log('Guest: recebendo offer do host', fid);
    await createPC(fid, false);
    const entry = peers.get(fid);
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      let answer = await entry.pc.createAnswer();
      answer.sdp = preferCodec(answer.sdp, ['VP8','H264']);
      await entry.pc.setLocalDescription(answer);
      sendWS({ type:'answer', to: msg.from, from: myId, roomId, sdp: entry.pc.localDescription });
      log('Guest: Answer enviada ao host');
    } catch(e){ console.warn('Guest handle offer fail', e); }
    return;
  }

  if (type === 'answer' && isHost) {
    const from = msg.from;
    if (handledAnswersFrom.has(from)) {
      log('Answer duplicada de', from, 'ignorando');
      return;
    }
    handledAnswersFrom.add(from);
    const entry = peers.get(from);
    if (entry) {
      try { await entry.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); log('Answer set de', from); } catch(e){ console.warn('setRemoteDescription answer fail', e); }
    } else {
      log('Answer de', from, 'mas pc nao existe ainda');
    }
    return;
  }

  if (type === 'ice') {
    const from = msg.from; const candidate = msg.candidate;
    if (peers.has(from)) {
      try { await peers.get(from).pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){ console.warn('ice add fail', e); }
    } else {
      for (const entry of peers.values()) {
        try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
      }
    }
    return;
  }

  if (!isHost && type === 'play') {
    if (!player.srcObject) {
      player.currentTime = msg.time || 0;
      player.play().catch(() => {
        // Autoplay bloqueado (iOS). Mostra um botão para o usuário iniciar o play.
        try { playBtn.style.display = 'inline-block'; } catch(e){}
        log('Autoplay bloqueado no guest — peça para o usuário tocar em Play.');
      });
    }
    return;
  }
  if (!isHost && type === 'pause') {
    if (!player.srcObject) { player.currentTime = msg.time || player.currentTime; player.pause(); }
    return;
  }

  if (!isHost && type === 'screen-stopped') {
    player.srcObject = null; player.src = '';
    log('Host parou o stream');
    return;
  }
}

// create RTCPeerConnection and manage tracks (host or guest)
async function createPC(peerId, makeOffer=false, remoteSdp=null) {
  if (peers.has(peerId)) { log('PC already exists for', peerId); return; }

  const iceServers = await fetchIceServers().catch(()=> [{ urls: 'stun:stun.l.google.com:19302' }]);

  const pc = new RTCPeerConnection({ iceServers });
  let dc = null;

  pc.onicecandidate = (e) => { if (e.candidate) sendWS({ type:'ice', to: peerId, from: myId, roomId, candidate: e.candidate }); };
  pc.onconnectionstatechange = () => log('PC', peerId, pc.connectionState);

  if (!isHost) {
    pc.ontrack = (event) => {
      const s = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      if (player.srcObject !== s) {
        player.srcObject = s;
        player.muted = true;
        player.play().catch(()=>{});
        player.controls = true; // <-- habilita controles para convidado (fullscreen etc)
        const fsBtn = document.getElementById('fsBtn'); if (fsBtn) fsBtn.style.display = 'inline-block';
        unmuteBtn.style.display = 'inline-block';
        log('Guest: stream remota aplicada ao player');
      } else {
        log('Guest: ontrack chamado, mesma stream já aplicada');
      }
    };
    pc.ondatachannel = (ev) => { dc = ev.channel; dc.onmessage = (m)=>{}; };
  } else {
    dc = pc.createDataChannel('ctrl');
    dc.onopen = () => log('Host DC open ->', peerId);
    if (outgoingStream) {
      for (const track of outgoingStream.getTracks()) {
        try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn('pc.addTrack fail', e); }
      }
    }
  }

  peers.set(peerId, { pc, dc });

  if (makeOffer) {
    try {
      if (isHost && outgoingStream) {
        for (const track of outgoingStream.getTracks()) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
          if (!sender) try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn(e); }
        }
      }
      let offer = await pc.createOffer();
      offer.sdp = preferCodec(offer.sdp, ['VP8','H264']);
      await pc.setLocalDescription(offer);
      const fp = (offer.sdp || '').slice(0,120);
      sendWS({ type:'offer', to: peerId, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
      log('Offer enviada para', peerId);
    } catch(e){ console.warn('offer fail', e); }
  } else if (remoteSdp) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));
      let answer = await pc.createAnswer();
      answer.sdp = preferCodec(answer.sdp, ['VP8','H264']);
      await pc.setLocalDescription(answer);
      sendWS({ type:'answer', to: remoteSdp.from || null, from: myId, roomId, sdp: pc.localDescription });
      log('Answer enviada ao host');
    } catch(e){ console.warn('answer fail', e); }
  }
}

(function(){ connectWS(); })();
