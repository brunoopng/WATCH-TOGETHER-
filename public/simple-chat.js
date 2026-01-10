// public/simple-chat.js
(function(){
  const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  let ws = null;
  let reconnectTimer = null;
  const messagesEl = document.getElementById('messages');
  const inputText = document.getElementById('inputText');
  const btnSend = document.getElementById('btnSend');

  function appendMessage(from, text, cls='their') {
    if(!messagesEl) return;
    const row = document.createElement('div');
    row.className = 'msg-row';
    const bubble = document.createElement('div');
    bubble.className = 'msg ' + (cls==='me' ? 'me' : 'their');
    bubble.innerHTML = `<div class="meta">${escapeHtml(from)}</div><div>${escapeHtml(text)}</div>`;
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function connect(){
    if(ws && ws.readyState === WebSocket.OPEN) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      console.log('simple-chat: conectado', WS_URL);
      if(btnSend) btnSend.disabled = false;
      appendMessage('system', 'Conectado ao servidor.');
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if(data && data.type === 'chat') {
          appendMessage(data.from || 'anon', data.text || '');
        } else {
          // caso servidor envie texto puro
          appendMessage('peer', typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
        }
      } catch(err){
        // fallback: texto simples
        appendMessage('peer', e.data);
      }
    };
    ws.onclose = () => {
      console.log('simple-chat: desconectado, tentando reconectar em 2s');
      if(btnSend) btnSend.disabled = true;
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = (err) => {
      console.warn('simple-chat ws error', err);
      try{ ws.close(); }catch(e){}
    };
  }

  function sendMessage(text){
    if(!ws || ws.readyState !== WebSocket.OPEN) return alert('Conexão não está aberta');
    const payload = { type: 'chat', from: (window.currentUser || 'convidado'), text: text };
    ws.send(JSON.stringify(payload));
    appendMessage(payload.from, payload.text, 'me');
  }

  // hookup UI (usa elementos do seu index.html)
  if (btnSend && inputText) {
    btnSend.disabled = true;
    btnSend.addEventListener('click', ()=>{
      const v = inputText.value.trim();
      if(!v) return;
      sendMessage(v);
      inputText.value = '';
    });
    inputText.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') { e.preventDefault(); btnSend.click(); } });
  }

  // start
  connect();

  // expose for debug
  window.simpleChat = { connect, sendMessage, ws };
})();
