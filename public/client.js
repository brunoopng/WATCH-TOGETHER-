// client.js — com suporte a TURN via backend (/ice)
// (Cole este arquivo em public/client.js ou adapte seu HTML para carregá-lo)

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

let qualityMode = 'auto'; // 'auto' or 'high'

// cria UI de seleção de qualidade se não existir
(function ensureQualityUI(){
  let container = document.getElementById('controls') || document.body;
  // evita duplicar
  if (document.getElementById('qualitySelect')) return;
  const wrap = document.createElement('div');
  wrap.style.display = 'inline-block';
  wrap.style.marginLeft = '12px';
  wrap.innerHTML = `
    <label style="font-size:12px; margin-right:6px;">Qualidade:</label>
    <select id="qualitySelect" title="Escolha qualidade do stream">
      <option value="auto">Auto (padrão)</option>
      <option value="high">Alta (720p, maior bitrate)</option>
    </select>
  `;
  // append próximo aos botões principais se possível
  if (document.getElementById('startStreamBtn')) {
    document.getElementById('startStreamBtn').insertAdjacentElement('afterend', wrap);
  } else {
    container.appendChild(wrap);
  }
  const sel = document.getElementById('qualitySelect');
  sel.addEventListener('change', (e) => {
    setQualityMode(e.target.value);
  });
})();

// Cria canvas capture (força resolução/fps)
function createCanvasCaptureFromPlayer(targetWidth = 1280, targetHeight = 720, fps = 30) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  // mantém canvas fora do DOM para não poluir a UI
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let rafId = null;
  const draw = () => {
    try {
      ctx.drawImage(player, 0, 0, canvas.width, canvas.height);
    } catch (e) {
      // ignore se frame ainda não disponível
    }
    rafId = requestAnimationFrame(draw);
  };
  rafId = requestAnimationFrame(draw);

  const stream = canvas.captureStream(fps);

  const stopAll = () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    // remove canvas do DOM após um pequeno timeout para garantir cleanup
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
    params.encodings[0].maxBitrate = bitrate; // ex: 1_500_000 = 1.5 Mbps
    if (typeof params.encodings[0].maxFramerate === 'undefined') params.encodings[0].maxFramerate = 30;
    await sender.setParameters(params);
    console.log('boostSenderParameters applied', bitrate, pc);
    return true;
  } catch (e) {
    console.warn('boostSenderParameters failed', e);
    return false;
  }
}

// aplica a qualidade escolhida: cria novo outgoingStream (se necessário),
// substitui tracks nos peers e faz renegociação (ofertas) para todos os PCs.
async function applyQualityToPeers(newMode) {
  // decide novo stream source
  let newStream = null;
  let canvasController = null;
  if (newMode === 'high') {
    // 720p@30 por padrão; pode ajustar aqui se quiser (ex: 1280x720)
    const { stream, stop, canvas } = createCanvasCaptureFromPlayer(1280, 720, 30);
    newStream = stream;
    canvasController = { stop, canvas };
  } else {
    // auto: usa player.captureStream (fallback se não suportado)
    if (typeof player.captureStream === 'function') {
      try { newStream = player.captureStream(); } catch(e){ console.warn('player.captureStream fail', e); newStream = null; }
    }
    // se não suportar, tenta usar existing outgoingStream (no host)
    if (!newStream && outgoingStream) newStream = outgoingStream;
  }

  if (!newStream) {
    log('Nao foi possivel criar novo stream para qualidade ' + newMode);
    return;
  }

  // Guarde referência antiga para cleanup
  const oldStream = outgoingStream;

  // substitui outgoingStream (mas não para o canvas antigo aqui)
  outgoingStream = newStream;
  outgoingStream._canvasController = canvasController || null;

  // Para cada peer: replaceTrack para video & audio, depois renegociar (offer)
  const peerIds = Array.from(peers.keys());
  for (const pid of peerIds) {
    const entry = peers.get(pid);
    if (!entry) continue;
    const pc = entry.pc;

    // replace/add tracks
    for (const track of outgoingStream.getTracks()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
      if (sender) {
        try { await sender.replaceTrack(track); } catch(e){ console.warn('replaceTrack fail', e); }
      } else {
        try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn('addTrack fail', e); }
      }
    }

    // opcional: dropar antigos senders que não existam mais
    // (não estritamente necessário)

    // tenta aumentar bitrate no sender
    await boostSenderParameters(pc, 1500000).catch(()=>{});

    // renegociação: cria offer após ajuste
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const fp = (offer.sdp || '').slice(0,120);
      sendWS({ type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
      log('Renegociação (offer) enviada para', pid, 'modo', newMode);
    } catch (e) {
      console.warn('Renegociação falhou para', pid, e);
    }
  }

  // para cleanup: finalize old stream (mas não remova objectURL do player)
  if (oldStream && oldStream !== newStream) {
    try {
      oldStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
      if (oldStream._stopCanvas) try { oldStream._stopCanvas(); } catch(e){}
    } catch(e){}
  }
}

// altera o modo de qualidade (chamado pela UI)
async function setQualityMode(mode) {
  if (!['auto','high'].includes(mode)) return;
  qualityMode = mode;
  const sel = document.getElementById('qualitySelect');
  if (sel) sel.value = mode;
  log('Modo de qualidade definido para', mode);

  // se host e já está transmitindo, aplica em tempo real
  if (isHost && outgoingStream) {
    log('Aplicando nova qualidade aos peers:', mode);
    await applyQualityToPeers(mode);
  }
}

// Modifique o fluxo do startStreamBtn: se qualidade === 'high' use canvas capture
// Substitua a linha outgoingStream = player.captureStream(); pelo trecho abaixo
// ou, caso não queira substituir manualmente, este bloco garante que ao iniciar
// o stream ele respete a qualidade selecionada:

const originalStartStreamHandler = startStreamBtn.onclick;
startStreamBtn.onclick = async function wrappedStartStreamHandler(evt) {
  // executa validações originais (se houver)
  try {
    // Se o selecionador de qualidade já definiu modo 'high', crie canvas stream.
    if (qualityMode === 'high') {
      // tenta criar canvas capture
      try {
        const { stream, stop } = createCanvasCaptureFromPlayer(1280, 720, 30);
        outgoingStream = stream;
        outgoingStream._stopCanvas = stop;
        log('Usando canvas capture para qualidade HIGH (720p@30).');
      } catch (e) {
        console.warn('Falha ao criar canvas capture, fallback para captureStream()', e);
        if (typeof player.captureStream === 'function') outgoingStream = player.captureStream();
      }
    } else {
      // auto
      if (typeof player.captureStream === 'function') {
        outgoingStream = player.captureStream();
        log('Usando player.captureStream() (modo AUTO).');
      } else {
        alert('captureStream() não disponível no navegador; use Chrome/Edge desktop ou escolha qualidade ALTA (canvas).');
        return;
      }
    }
    // segue com o código original do startStream: anexar tracks e negociar
    // replicamos a lógica que você já tinha: for each peer add/replace tracks and offer
    const toNegotiate = Array.from(new Set([...peers.keys(), ...pendingPeers]));
    pendingPeers.clear();
    for (const pid of toNegotiate) {
      const entry = peers.get(pid);
      if (!entry) {
        log('Criando PC para', pid, 'antes da negociação');
        await createPC(pid, false); // create pc if missing
      }
      const pc = peers.get(pid).pc;
      // add/replace tracks
      for (const track of outgoingStream.getTracks()) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
        if (sender) {
          try { await sender.replaceTrack(track); } catch(e){ console.warn('replaceTrack fail', e); }
        } else {
          try { pc.addTrack(track, outgoingStream); } catch(e){ console.warn('addTrack fail', e); }
        }
      }
      // apply bitrate boost
      await boostSenderParameters(pc, 1500000).catch(()=>{});
      // offer after tracks attached
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const fp = (offer.sdp || '').slice(0,120);
        sendWS({ type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
        log('Offer (com tracks) enviada para', pid);
      } catch(err){ console.warn('reneg fail', err); }
    }

    // attach onended from outgoing video track if exists
    const vt = outgoingStream.getVideoTracks()[0];
    if (vt) vt.onended = () => { log('Stream finalizado pelo host'); sendWS({ type:'screen-stopped', roomId }); outgoingStream = null; };

  } catch (err) {
    console.warn('Erro no wrappedStartStreamHandler', err);
  }

  // call original handler if it existed (some older logic might be in original)
  try { if (typeof originalStartStreamHandler === 'function') originalStartStreamHandler.call(this, evt); } catch(e){}
};

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
      console.warn('fetchIceServers fail, usando fallback STUN', err);
      if (!ICE_CACHE.iceServers || !ICE_CACHE.iceServers.length) {
        ICE_CACHE.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        ICE_CACHE.expires = Date.now() + (30*1000);
      }
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
  player.play().catch(()=>{});
  log('Arquivo carregado (host). Use "Iniciar stream" para transmitir.');
};

// Host: start captureStream and attach tracks to peers
startStreamBtn.onclick = async () => {
  if (!isHost) return alert('Somente host pode iniciar o stream');
  if (!player.src && !player.srcObject) return alert('Carregue um vídeo antes');
  try { await player.play(); } catch(e){ console.warn('play failed', e); }
  if (typeof player.captureStream !== 'function') {
    alert('captureStream() não disponível neste navegador. Use Chrome/Edge desktop.');
    return;
  }
  outgoingStream = player.captureStream();
  log('captureStream() criado; anexando tracks aos peers e negociando.');

  const toNegotiate = Array.from(new Set([...peers.keys(), ...pendingPeers]));
  pendingPeers.clear();
  for (const pid of toNegotiate) {
    const entry = peers.get(pid);
    if (!entry) {
      log('Criando PC para', pid, 'antes da negociação');
      await createPC(pid, false); // create pc if missing
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
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const fp = (offer.sdp || '').slice(0,120);
      sendWS({ type:'offer', to: pid, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
      log('Offer (com tracks) enviada para', pid);
    } catch(err){ console.warn('reneg fail', err); }
  }

  const vt = outgoingStream.getVideoTracks()[0];
  if (vt) vt.onended = () => { log('Stream finalizado pelo host'); sendWS({ type:'screen-stopped', roomId }); outgoingStream = null; };
};

playBtn.onclick = async () => {
  if (!isHost) return;
  try { await player.play(); } catch(e){ console.warn('player.play failed', e); }
  if (!outgoingStream && typeof player.captureStream === 'function') {
    try { outgoingStream = player.captureStream(); log('captureStream() criado no play'); } catch(e){ console.warn(e); }
  }
  sendWS({ type:'play', roomId, time: player.currentTime });
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
        const offer = await pc.createOffer();
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
      const answer = await entry.pc.createAnswer();
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
    if (!player.srcObject) { player.currentTime = msg.time || 0; player.play().catch(()=>{}); }
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
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const fp = (offer.sdp || '').slice(0,120);
      sendWS({ type:'offer', to: peerId, from: myId, roomId, sdp: pc.localDescription, offerFingerprint: fp });
      log('Offer enviada para', peerId);
    } catch(e){ console.warn('offer fail', e); }
  } else if (remoteSdp) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWS({ type:'answer', to: remoteSdp.from || null, from: myId, roomId, sdp: pc.localDescription });
      log('Answer enviada ao host');
    } catch(e){ console.warn('answer fail', e); }
  }
}

(function(){ connectWS(); })();
