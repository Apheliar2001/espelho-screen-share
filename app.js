const $ = (id) => document.getElementById(id);
const session = new URLSearchParams(location.search).get('session');
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const isViewer = Boolean(session);
let socket, peer, localStream, queuedCandidates = [], sessionId = session, isPresenter = false, sessionCreationTimer;
let signalReady;

if (isViewer) {
  document.body.classList.add('viewer-mode'); $('roleBanner').textContent = 'ESPECTADOR · AGUARDANDO'; $('roleBanner').classList.add('viewer');
  $('eyebrow').textContent = 'ESPECTADOR'; $('heroTitle').innerHTML = 'A transmissão<br /><em>vai começar.</em>'; $('intro').textContent = 'Você está na sala de visualização. A imagem aparecerá assim que o transmissor estiver disponível.';
  $('shareButton').hidden = true; $('stopButton').hidden = true; $('roomLink').textContent = 'Você está acessando uma transmissão privada.'; $('copyButton').hidden = true;
  stage('Validando o link de acesso…');
}
$('copyButton').onclick = async () => { await navigator.clipboard.writeText($('roomLink').textContent); $('copyButton').textContent = 'Copiado!'; setTimeout(() => $('copyButton').textContent = 'Copiar link', 1600); };
function status(text, variant = 'neutral') { const el = $('connectionStatus'); el.textContent = text; el.className = `status ${variant}`; }
function stage(text) { $('stageMessage').textContent = text; }
function setLink(room) { $('roomLink').textContent = `${location.origin}${location.pathname}?session=${room}`; $('copyButton').disabled = false; }
function createPeer() {
  if (peer) peer.close(); peer = new RTCPeerConnection({ iceServers });
  peer.onicecandidate = ({ candidate }) => candidate && signal({ type: 'ice-candidate', candidate });
  peer.ontrack = ({ streams }) => {
    const video = $('remoteVideo');
    video.muted = true;
    video.srcObject = streams[0];
    video.classList.add('active'); $('emptyState').hidden = true; $('roleBanner').classList.add('watching'); $('roleBanner').textContent = 'ESPECTADOR · CONECTADO'; $('unmuteButton').hidden = false; $('fullscreenButton').hidden = false;
    video.play().catch(() => { video.onloadedmetadata = () => video.play().catch(() => {}); });
    status('Assistindo à transmissão', 'connected');
  };
  peer.onconnectionstatechange = () => { if (peer.connectionState === 'disconnected' || peer.connectionState === 'failed') status('Conexão interrompida', 'warning'); };
  if (localStream) localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
}
function signal(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
async function makeOffer() { createPeer(); const offer = await peer.createOffer(); await peer.setLocalDescription(offer); signal({ type: 'offer', sdp: offer }); }
function invalidate(message) {
  peer?.close(); peer = null; sessionId = null; localStream?.getTracks().forEach(track => track.stop()); localStream = null;
  $('remoteVideo').classList.remove('active'); $('emptyState').hidden = false; $('presentingBadge').hidden = true; $('stopButton').hidden = true; $('fullscreenButton').hidden = true; $('roleBanner').classList.remove('live', 'watching');
  if (!isViewer) { isPresenter = false; $('shareButton').hidden = false; $('shareButton').disabled = false; $('shareButton').textContent = 'Compartilhar minha tela'; $('copyButton').disabled = true; $('roomLink').textContent = 'O link anterior expirou. Inicie outra transmissão para criar um novo.'; }
  status('Link expirado', 'warning'); stage(message);
}
async function receiveSignal(message) {
  if (message.type === 'session-created') { clearTimeout(sessionCreationTimer); sessionId = message.room; isPresenter = true; $('roleBanner').classList.add('live'); $('roleBanner').textContent = 'TRANSMISSOR · AO VIVO'; $('stageTitle').textContent = 'Transmissão disponível'; setLink(sessionId); status('Link criado — aguardando acesso', 'connected'); stage('Envie o acesso acima para o espectador.'); return; }
  if (message.type === 'joined') { status(message.peers ? 'Conectando ao transmissor…' : (isPresenter ? 'Aguardando espectador' : 'Aguardando transmissor'), 'neutral'); return; }
  if (message.type === 'peer-joined' && isPresenter) { status('Espectador entrou', 'connected'); await makeOffer(); }
  if (message.type === 'offer') { createPeer(); await peer.setRemoteDescription(message.sdp); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); signal({ type: 'answer', sdp: answer }); }
  if (message.type === 'answer' && peer) await peer.setRemoteDescription(message.sdp);
  if (message.type === 'ice-candidate' && peer) { if (peer.remoteDescription) await peer.addIceCandidate(message.candidate); else queuedCandidates.push(message.candidate); }
  if ((message.type === 'offer' || message.type === 'answer') && peer) { for (const candidate of queuedCandidates) await peer.addIceCandidate(candidate); queuedCandidates = []; }
  if (message.type === 'peer-left') { status('Aguardando outra pessoa', 'neutral'); if (!isPresenter) { $('remoteVideo').classList.remove('active'); $('emptyState').hidden = false; stage('O transmissor saiu da sala.'); } }
  if (message.type === 'session-expired') invalidate('Esta transmissão terminou ou foi substituída por uma nova.');
  if (message.type === 'invalid-session' || message.type === 'room-full') invalidate(message.type === 'room-full' ? 'Esta transmissão já atingiu o limite de espectadores.' : 'Este link expirou ou não é válido.');
}
function connectSignal() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'; socket = new WebSocket(`${protocol}://${location.host}`);
  signalReady = new Promise((resolve, reject) => {
    socket.onopen = () => {
      if (isViewer) signal({ type: 'join', room: sessionId });
      else { document.body.classList.add('presenter-mode'); $('roleBanner').textContent = 'TRANSMISSOR · PRONTO'; $('roleBanner').classList.add('presenter'); $('shareButton').disabled = false; status('Pronto para transmitir', 'connected'); $('stageTitle').textContent = 'Sua sala está pronta'; stage('Inicie a transmissão para criar um acesso temporário.'); }
      resolve();
    };
    socket.onerror = () => reject(new Error('Não foi possível conectar ao servidor.'));
  });
  socket.onmessage = async (event) => { try { await receiveSignal(JSON.parse(event.data)); } catch (error) { console.error(error); status('Falha na conexão', 'error'); } };
  socket.onclose = () => { if (!socket?.closedByUser && !isViewer && sessionId) status('Servidor desconectado', 'error'); };
}
$('shareButton').onclick = async () => {
  try {
    $('shareButton').disabled = true; $('shareButton').textContent = 'Preparando transmissão…';
    await signalReady;
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    $('shareButton').hidden = true; $('stopButton').hidden = false; $('presentingBadge').hidden = false;
    localStream.getVideoTracks()[0].onended = stopSharing; signal({ type: 'create-session' });
    sessionCreationTimer = setTimeout(() => {
      if (!sessionId) invalidate('O servidor não confirmou a criação do link. Reinicie-o com npm start e tente novamente.');
    }, 3500);
  } catch (error) {
    $('shareButton').disabled = false; $('shareButton').textContent = 'Compartilhar minha tela';
    if (error.name !== 'NotAllowedError') { console.error(error); alert('Não foi possível iniciar. Confirme que o servidor está em execução e recarregue a página.'); }
  }
};
function stopSharing() { clearTimeout(sessionCreationTimer); if (sessionId) signal({ type: 'end-session' }); else invalidate('A transmissão foi encerrada.'); }
$('stopButton').onclick = stopSharing;
$('unmuteButton').onclick = async () => { const video = $('remoteVideo'); video.muted = false; await video.play(); $('unmuteButton').hidden = true; };
$('fullscreenButton').onclick = () => $('remoteVideo').requestFullscreen?.();
connectSignal();
