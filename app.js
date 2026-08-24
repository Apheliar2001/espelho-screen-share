const $ = (id) => document.getElementById(id);
const session = new URLSearchParams(location.search).get('session');
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const isViewer = Boolean(session);
let socket, peer, localStream, sessionId = session, isPresenter = false, sessionCreationTimer;
const peers = new Map();
const queuedCandidates = new Map();
let signalReady;

if (isViewer) {
  document.body.classList.add('viewer-mode'); setRoleStatus('RECEPTOR', 'NÃO DISPONÍVEL', false);
  $('eyebrow').textContent = 'RECEPTOR'; $('heroTitle').innerHTML = 'A transmissão<br /><em>vai começar.</em>'; $('intro').textContent = 'Você está na sala de visualização. A imagem aparecerá assim que o transmissor estiver disponível.';
  $('shareButton').hidden = true; $('stopButton').hidden = true; $('roomLink').textContent = 'Você está acessando uma transmissão privada.'; $('copyButton').hidden = true;
  stage('Validando o link de acesso…');
}
$('copyButton').onclick = async () => { await navigator.clipboard.writeText($('roomLink').textContent); $('copyButton').textContent = 'Copiado!'; setTimeout(() => $('copyButton').textContent = 'Copiar link', 1600); };
function status(text, variant = 'neutral') { const el = $('connectionStatus'); el.textContent = text; el.className = `status ${variant}`; }
function stage(text) { $('stageMessage').textContent = text; }
function setRoleStatus(role, state, positive) { const banner = $('roleBanner'); banner.textContent = `${role} · ${state}`; banner.className = `role-banner ${positive ? 'positive' : 'negative'}`; }
function setLink(room) { $('roomLink').textContent = `${location.origin}${location.pathname}?session=${room}`; $('copyButton').disabled = false; }
function createPeer(peerId) {
  const previous = peers.get(peerId); if (previous) previous.close();
  const connection = new RTCPeerConnection({ iceServers }); peers.set(peerId, connection);
  if (!isPresenter) peer = connection;
  connection.onicecandidate = ({ candidate }) => candidate && signal({ type: 'ice-candidate', candidate, to: peerId });
  connection.ontrack = ({ streams }) => {
    const video = $('remoteVideo');
    video.muted = true;
    video.srcObject = streams[0];
    video.classList.add('active'); $('emptyState').hidden = true; setRoleStatus('RECEPTOR', 'ATIVO', true); $('unmuteButton').hidden = false; $('fullscreenButton').hidden = false;
    video.play().catch(() => { video.onloadedmetadata = () => video.play().catch(() => {}); });
    status('Receptor ativo', 'connected');
  };
  connection.onconnectionstatechange = () => { if (connection.connectionState === 'disconnected' || connection.connectionState === 'failed') status('Conexão interrompida', 'warning'); };
  if (localStream) localStream.getTracks().forEach(track => connection.addTrack(track, localStream));
  return connection;
}
function signal(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
async function makeOffer(peerId) { const connection = createPeer(peerId); const offer = await connection.createOffer(); await connection.setLocalDescription(offer); signal({ type: 'offer', sdp: offer, to: peerId }); }
function invalidate(message) {
  for (const connection of peers.values()) connection.close(); peers.clear(); peer = null; sessionId = null; localStream?.getTracks().forEach(track => track.stop()); localStream = null;
  $('remoteVideo').classList.remove('active'); $('emptyState').hidden = false; $('presentingBadge').hidden = true; $('stopButton').hidden = true; $('changeScreenButton').hidden = true; $('fullscreenButton').hidden = true;
  if (!isViewer) { isPresenter = false; setRoleStatus('TRANSMISSOR', 'NÃO ATIVO', false); $('shareButton').hidden = false; $('shareButton').disabled = false; $('shareButton').textContent = 'Compartilhar minha tela'; $('copyButton').disabled = true; $('roomLink').textContent = 'O link anterior expirou. Inicie outra transmissão para criar um novo.'; }
  else setRoleStatus('RECEPTOR', 'NÃO DISPONÍVEL', false);
  status('Link expirado', 'warning'); stage(message);
}
async function receiveSignal(message) {
  if (message.type === 'session-created') { clearTimeout(sessionCreationTimer); sessionId = message.room; isPresenter = true; setRoleStatus('TRANSMISSOR', 'ATIVO', true); $('stageTitle').textContent = 'Transmissão disponível'; setLink(sessionId); status('Transmissor ativo', 'connected'); stage('Envie o acesso acima para o receptor.'); return; }
  if (message.type === 'joined') { setRoleStatus('RECEPTOR', 'DISPONÍVEL', true); status('Receptor disponível', 'connected'); return; }
  if (message.type === 'peer-joined' && isPresenter) { status(`${message.viewers} receptor(es) ativo(s)`, 'connected'); await makeOffer(message.peerId); }
  if (message.type === 'offer') { const connection = createPeer(message.from); await connection.setRemoteDescription(message.sdp); const answer = await connection.createAnswer(); await connection.setLocalDescription(answer); signal({ type: 'answer', sdp: answer, to: message.from }); for (const candidate of queuedCandidates.get(message.from) || []) await connection.addIceCandidate(candidate); queuedCandidates.delete(message.from); }
  if (message.type === 'answer') { const connection = peers.get(message.from); if (connection) { await connection.setRemoteDescription(message.sdp); for (const candidate of queuedCandidates.get(message.from) || []) await connection.addIceCandidate(candidate); queuedCandidates.delete(message.from); } }
  if (message.type === 'ice-candidate') { const connection = peers.get(message.from); if (connection?.remoteDescription) await connection.addIceCandidate(message.candidate); else queuedCandidates.set(message.from, [...(queuedCandidates.get(message.from) || []), message.candidate]); }
  if (message.type === 'peer-left') { peers.get(message.peerId)?.close(); peers.delete(message.peerId); status(isPresenter ? `${peers.size} receptor(es) ativo(s)` : 'Receptor não ativo', isPresenter ? 'connected' : 'error'); if (!isPresenter) { $('remoteVideo').classList.remove('active'); $('emptyState').hidden = false; setRoleStatus('RECEPTOR', 'NÃO ATIVO', false); stage('O transmissor saiu da sala.'); } }
  if (message.type === 'session-expired') invalidate('Esta transmissão terminou ou foi substituída por uma nova.');
  if (message.type === 'invalid-session' || message.type === 'room-full') invalidate(message.type === 'room-full' ? 'Esta transmissão já atingiu o limite de espectadores.' : 'Este link expirou ou não é válido.');
}
function connectSignal() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'; socket = new WebSocket(`${protocol}://${location.host}`);
  signalReady = new Promise((resolve, reject) => {
    socket.onopen = () => {
      if (isViewer) signal({ type: 'join', room: sessionId });
      else { document.body.classList.add('presenter-mode'); setRoleStatus('TRANSMISSOR', 'DISPONÍVEL', true); $('shareButton').disabled = false; status('Transmissor disponível', 'connected'); $('stageTitle').textContent = 'Sua sala está pronta'; stage('Inicie a transmissão para criar um acesso temporário.'); }
      resolve();
    };
    socket.onerror = () => reject(new Error('Não foi possível conectar ao servidor.'));
  });
  socket.onmessage = async (event) => { try { await receiveSignal(JSON.parse(event.data)); } catch (error) { console.error(error); status('Falha na conexão', 'error'); } };
  socket.onclose = () => { if (!socket?.closedByUser) { status('Não disponível', 'error'); setRoleStatus(isViewer ? 'RECEPTOR' : 'TRANSMISSOR', 'NÃO DISPONÍVEL', false); } };
}
$('changeScreenButton').onclick = async () => {
  try {
    const selectedStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const newVideo = selectedStream.getVideoTracks()[0];
    if (!newVideo) return;
    for (const connection of peers.values()) {
      const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
      await sender?.replaceTrack(newVideo);
    }
    const previousVideo = localStream?.getVideoTracks()[0];
    const previousAudio = localStream?.getAudioTracks() || [];
    selectedStream.getAudioTracks().forEach((track) => track.stop());
    localStream = new MediaStream([newVideo, ...previousAudio]);
    newVideo.onended = () => { if (localStream?.getVideoTracks()[0] === newVideo) stopSharing(); };
    previousVideo?.stop();
    stage('Tela/janela alterada com sucesso.');
  } catch (error) { if (error.name !== 'NotAllowedError') console.error(error); }
};
$('shareButton').onclick = async () => {
  try {
    $('shareButton').disabled = true; $('shareButton').textContent = 'Preparando transmissão…';
    await signalReady;
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    $('shareButton').hidden = true; $('changeScreenButton').hidden = false; $('stopButton').hidden = false; $('presentingBadge').hidden = false;
    const initialVideo = localStream.getVideoTracks()[0]; initialVideo.onended = () => { if (localStream?.getVideoTracks()[0] === initialVideo) stopSharing(); }; signal({ type: 'create-session' });
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
