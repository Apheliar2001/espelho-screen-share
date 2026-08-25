const $ = (id) => document.getElementById(id);
const streamId = new URLSearchParams(location.search).get('stream');
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
const isViewer = Boolean(streamId);
const hostStorageKey = 'apheliar-screen-host-id';
const userStorageKey = 'apheliar-screen-user-name';
const hostId = localStorage.getItem(hostStorageKey) || crypto.randomUUID().replaceAll('-', '');
localStorage.setItem(hostStorageKey, hostId);
let socket, peer, localStream, sessionId = null, isPresenter = false, sessionCreationTimer, joinedStream = false, joiningStream = false, viewerAuthorized = false;
const peers = new Map();
const queuedCandidates = new Map();
let signalReady;
const captureOptions = { video: { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: { suppressLocalAudioPlayback: false }, systemAudio: 'include', surfaceSwitching: 'include' };

if (isViewer) {
  document.body.classList.add('viewer-mode'); setRoleStatus('RECEPTOR', 'NÃO DISPONÍVEL', false);
  $('eyebrow').textContent = 'RECEPTOR'; $('heroTitle').innerHTML = 'A transmissão<br /><em>vai começar.</em>'; $('intro').textContent = 'Você está na sala de visualização. A imagem aparecerá assim que o transmissor estiver disponível.';
  $('displayName').value = localStorage.getItem(userStorageKey) || ''; $('hostActions').hidden = true; $('viewerActions').hidden = false; $('joinViewerButton').disabled = !$('displayName').value.trim(); $('stopButton').hidden = true; $('roomLink').textContent = 'Você está acessando um link fixo de transmissão.'; $('copyButton').hidden = true;
  stage('Informe seu usuário para entrar na transmissão.');
} else {
  $('displayName').value = localStorage.getItem(userStorageKey) || '';
}
$('copyButton').onclick = async () => { await navigator.clipboard.writeText($('roomLink').textContent); $('copyButton').textContent = 'Copiado!'; setTimeout(() => $('copyButton').textContent = 'Copiar link', 1600); };
function status(text, variant = 'neutral') { const el = $('connectionStatus'); el.textContent = text; el.className = `status ${variant}`; }
function stage(text) { $('stageMessage').textContent = text; }
function reportCapture(stream) {
  const video = stream.getVideoTracks()[0]; const audio = stream.getAudioTracks()[0];
  if (video && 'contentHint' in video) video.contentHint = 'motion';
  const settings = video?.getSettings?.() || {};
  const quality = settings.frameRate ? `${Math.round(settings.frameRate)} FPS solicitados` : 'perfil de movimento ativo';
  $('mediaStatus').textContent = audio ? `Áudio capturado · ${quality}` : `Áudio não foi capturado pelo navegador · ${quality}`;
}
async function prioritizeMotion(sender) {
  try {
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-framerate';
    if (parameters.encodings?.length) { parameters.encodings[0].maxBitrate = 5_000_000; parameters.encodings[0].maxFramerate = 60; }
    await sender.setParameters(parameters);
  } catch { /* Browser does not support changing these WebRTC preferences. */ }
}
function setRoleStatus(role, state, positive) { const banner = $('roleBanner'); banner.textContent = `${role} · ${state}`; banner.className = `role-banner ${positive ? 'positive' : 'negative'}`; }
function fixedLink(id = hostId) { return `${location.origin}${location.pathname}?stream=${id}`; }
function setLink() { $('roomLink').textContent = fixedLink(); $('copyButton').disabled = false; }
function updateStreamOwner(streams) {
  if (!isViewer) return;
  const owner = streams.find((stream) => stream.id === streamId);
  const cacheKey = `apheliar-screen-owner-${streamId}`;
  if (owner) localStorage.setItem(cacheKey, owner.name);
  const name = owner?.name || localStorage.getItem(cacheKey);
  $('streamOwner').hidden = !name;
  if (name) $('streamOwner').textContent = `Transmissão de: ${name}`;
}
function renderOnline(streams) {
  const list = $('onlineList'); list.replaceChildren();
  if (!streams.length) { const item = document.createElement('li'); item.textContent = 'Nenhuma transmissão ativa.'; list.append(item); return; }
  for (const stream of streams) { const item = document.createElement('li'); const link = document.createElement('a'); link.href = fixedLink(stream.id); link.target = '_blank'; link.rel = 'noopener'; link.textContent = stream.name; item.append(link); list.append(item); }
}
function renderWatchers(viewers) { const list = $('watcherList'); list.replaceChildren(); if (!viewers.length) { const item = document.createElement('li'); item.textContent = 'Ninguém assistindo.'; list.append(item); return; } for (const viewer of viewers) { const item = document.createElement('li'); item.textContent = viewer; list.append(item); } }
function joinCurrentStream() { const name = $('displayName').value.trim(); if (isViewer && viewerAuthorized && !joinedStream && !joiningStream && socket?.readyState === WebSocket.OPEN && name) { joiningStream = true; localStorage.setItem(userStorageKey, name); signal({ type: 'join', hostId: streamId, name }); } }
$('displayName').oninput = () => { const name = $('displayName').value.trim(); localStorage.setItem(userStorageKey, name); if (isViewer) $('joinViewerButton').disabled = !name; };
$('joinViewerButton').onclick = () => { const name = $('displayName').value.trim(); if (!name) { $('displayName').focus(); return; } viewerAuthorized = true; $('joinViewerButton').disabled = true; $('joinViewerButton').textContent = 'Entrando…'; stage('Solicitando entrada como ' + name + '…'); joinCurrentStream(); };
$('browseOnlineButton').onclick = () => $('onlineList').scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (localStream) localStream.getTracks().forEach(track => { const sender = connection.addTrack(track, localStream); if (track.kind === 'video') prioritizeMotion(sender); });
  return connection;
}
function signal(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
async function makeOffer(peerId) { const connection = createPeer(peerId); const offer = await connection.createOffer(); await connection.setLocalDescription(offer); signal({ type: 'offer', sdp: offer, to: peerId }); }
function invalidate(message) {
  for (const connection of peers.values()) connection.close(); peers.clear(); peer = null; sessionId = null; joinedStream = false; joiningStream = false; localStream?.getTracks().forEach(track => track.stop()); localStream = null;
  $('remoteVideo').classList.remove('active'); $('emptyState').hidden = false; $('presentingBadge').hidden = true; $('stopButton').hidden = true; $('changeScreenButton').hidden = true; $('fullscreenButton').hidden = true; $('watchingPanel').hidden = true;
  if (!isViewer) { isPresenter = false; setRoleStatus('TRANSMISSOR', 'NÃO ATIVO', false); $('shareButton').hidden = false; $('shareButton').disabled = false; $('shareButton').textContent = 'Compartilhar minha tela'; setLink(); }
  else setRoleStatus('RECEPTOR', 'NÃO DISPONÍVEL', false);
  status('Link expirado', 'warning'); stage(message);
}
async function receiveSignal(message) {
  if (message.type === 'online-streams') { renderOnline(message.streams); updateStreamOwner(message.streams); if (isViewer) joinCurrentStream(); return; }
  if (message.type === 'watchers' && !isViewer) { $('watchingPanel').hidden = false; renderWatchers(message.viewers); return; }
  if (message.type === 'session-created') { clearTimeout(sessionCreationTimer); sessionId = message.room; isPresenter = true; $('watchingPanel').hidden = false; renderWatchers([]); setRoleStatus('TRANSMISSOR', 'ATIVO', true); $('stageTitle').textContent = 'Transmissão disponível'; setLink(); status('Transmissor ativo', 'connected'); stage('Seu link fixo está online para os receptores.'); return; }
  if (message.type === 'joined') { joiningStream = false; joinedStream = true; $('joinViewerButton').hidden = true; setRoleStatus('RECEPTOR', 'DISPONÍVEL', true); status('Receptor disponível', 'connected'); return; }
  if (message.type === 'peer-joined' && isPresenter) { status(`${message.viewers} receptor(es) ativo(s)`, 'connected'); await makeOffer(message.peerId); }
  if (message.type === 'offer') { const connection = createPeer(message.from); await connection.setRemoteDescription(message.sdp); const answer = await connection.createAnswer(); await connection.setLocalDescription(answer); signal({ type: 'answer', sdp: answer, to: message.from }); for (const candidate of queuedCandidates.get(message.from) || []) await connection.addIceCandidate(candidate); queuedCandidates.delete(message.from); }
  if (message.type === 'answer') { const connection = peers.get(message.from); if (connection) { await connection.setRemoteDescription(message.sdp); for (const candidate of queuedCandidates.get(message.from) || []) await connection.addIceCandidate(candidate); queuedCandidates.delete(message.from); } }
  if (message.type === 'ice-candidate') { const connection = peers.get(message.from); if (connection?.remoteDescription) await connection.addIceCandidate(message.candidate); else queuedCandidates.set(message.from, [...(queuedCandidates.get(message.from) || []), message.candidate]); }
  if (message.type === 'peer-left') { peers.get(message.peerId)?.close(); peers.delete(message.peerId); status(isPresenter ? `${peers.size} receptor(es) ativo(s)` : 'Receptor não ativo', isPresenter ? 'connected' : 'error'); if (!isPresenter) { $('remoteVideo').classList.remove('active'); $('emptyState').hidden = false; setRoleStatus('RECEPTOR', 'NÃO ATIVO', false); stage('O transmissor saiu da sala.'); } }
  if (message.type === 'session-expired') invalidate('Esta transmissão foi encerrada. O mesmo link voltará a funcionar quando o transmissor iniciar novamente.');
  if (message.type === 'stream-unavailable') { joiningStream = false; joinedStream = false; $('joinViewerButton').disabled = false; $('joinViewerButton').textContent = 'Entrar na transmissão'; setRoleStatus('RECEPTOR', 'NÃO DISPONÍVEL', false); status('Receptor não disponível', 'error'); stage('Esta transmissão está offline. Aguarde o transmissor iniciar.'); }
  if (message.type === 'room-full') invalidate('Esta transmissão já atingiu o limite de receptores.');
}
function connectSignal() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'; socket = new WebSocket(`${protocol}://${location.host}`);
  signalReady = new Promise((resolve, reject) => {
    socket.onopen = () => {
      if (isViewer) { if (viewerAuthorized) joinCurrentStream(); else status('Informe seu usuário para entrar', 'neutral'); }
      else { document.body.classList.add('presenter-mode'); setRoleStatus('TRANSMISSOR', 'DISPONÍVEL', true); setLink(); $('shareButton').disabled = false; status('Transmissor disponível', 'connected'); $('stageTitle').textContent = 'Sua sala está pronta'; stage('Inicie a transmissão para ficar online com seu link fixo.'); }
      resolve();
    };
    socket.onerror = () => reject(new Error('Não foi possível conectar ao servidor.'));
  });
  socket.onmessage = async (event) => { try { await receiveSignal(JSON.parse(event.data)); } catch (error) { console.error(error); status('Falha na conexão', 'error'); } };
  socket.onclose = () => { if (!socket?.closedByUser) { status('Não disponível', 'error'); setRoleStatus(isViewer ? 'RECEPTOR' : 'TRANSMISSOR', 'NÃO DISPONÍVEL', false); } };
}
$('changeScreenButton').onclick = async () => {
  try {
    const selectedStream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
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
    reportCapture(localStream);
    newVideo.onended = () => { if (localStream?.getVideoTracks()[0] === newVideo) stopSharing(); };
    previousVideo?.stop();
    stage('Tela/janela alterada com sucesso.');
  } catch (error) { if (error.name !== 'NotAllowedError') console.error(error); }
};
$('shareButton').onclick = async () => {
  try {
    const name = $('displayName').value.trim();
    if (!name) { $('displayName').focus(); stage('Informe seu nome de transmissão antes de iniciar.'); return; }
    localStorage.setItem(userStorageKey, name);
    $('shareButton').disabled = true; $('shareButton').textContent = 'Preparando transmissão…';
    await signalReady;
    localStream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
    reportCapture(localStream);
    $('shareButton').hidden = true; $('changeScreenButton').hidden = false; $('stopButton').hidden = false; $('presentingBadge').hidden = false;
    const initialVideo = localStream.getVideoTracks()[0]; initialVideo.onended = () => { if (localStream?.getVideoTracks()[0] === initialVideo) stopSharing(); }; signal({ type: 'create-session', hostId, name });
    sessionCreationTimer = setTimeout(() => {
      if (!sessionId) invalidate('O servidor não confirmou a criação do link. Reinicie-o com npm start e tente novamente.');
    }, 3500);
  } catch (error) {
    $('shareButton').disabled = false; $('shareButton').textContent = 'Compartilhar minha tela';
    if (error.name !== 'NotAllowedError') { console.error(error); alert('Não foi possível iniciar. Confirme que o servidor está em execução e recarregue a página.'); }
  }
};
function stopSharing() { clearTimeout(sessionCreationTimer); if (isPresenter) signal({ type: 'end-session' }); else invalidate('A transmissão foi encerrada.'); }
$('stopButton').onclick = stopSharing;
$('unmuteButton').onclick = async () => { const video = $('remoteVideo'); video.muted = false; await video.play(); $('unmuteButton').hidden = true; };
$('fullscreenButton').onclick = () => $('remoteVideo').requestFullscreen?.();
connectSignal();
