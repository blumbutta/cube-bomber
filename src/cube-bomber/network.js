export const CUBE_SERVER_URL = 'https://kozlogon-server.onrender.com';
const SESSION_KEY = 'cube-bomber-room-session';

export function websocketUrl(base = CUBE_SERVER_URL) {
  const url = new URL(base);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Некорректный адрес сервера.');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = '/cube-ws'; url.search = ''; url.hash = ''; return url.href;
}

export function applySnapshot(game, state) {
  const { humanIds, collapsedFaces, faceCollapses, ...values } = state;
  Object.assign(game, values);
  game.humanIds = new Set(humanIds || []); game.collapsedFaces = new Set(collapsedFaces || []);
  game.faceCollapses = new Map(faceCollapses || []); game.botsEnabled = false;
  return game;
}

export class CubeClient {
  constructor({ url = CUBE_SERVER_URL, onMessage = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
    this.url = websocketUrl(url); this.onMessage = onMessage; this.onStatus = onStatus; this.onError = onError;
    this.socket = null; this.session = null; this.room = null; this.phase = null; this.sequence = 0; this.direction = null;
    this.intentional = false; this.retry = 0; this.retryTimer = null; this.connectPromise = null; this.lastInputAt = 0;
    try { this.savedSession = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { this.savedSession = null; }
    this.pulse = setInterval(() => { if (this.connected && this.phase === 'playing') this.sendInput(); }, 200);
    this.pulse.unref?.();
  }
  get connected() { return this.socket?.readyState === 1; }
  get active() { return Boolean(this.session); }
  get playerId() { return this.session?.playerId ?? null; }
  get memberId() { return this.session?.memberId ?? null; }
  get roomId() { return this.session?.roomId ?? null; }
  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.intentional = false; clearTimeout(this.retryTimer);
    this.onStatus(this.session ? 'reconnecting' : 'connecting');
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Сервер долго отвечает. Попробуй ещё раз.')); }, 45_000);
      socket.onopen = () => {
        clearTimeout(timeout); this.retry = 0; this.connectPromise = null; this.onStatus('connected');
        if (this.session) this.send({ type: 'join', roomId: this.session.roomId, reconnectToken: this.session.reconnectToken });
        resolve();
      };
      socket.onmessage = event => {
        let packet; try { packet = JSON.parse(event.data); } catch { return; }
        if (packet.type === 'welcome') {
          this.session = { roomId: packet.roomId, memberId: packet.memberId, playerId: packet.playerId, reconnectToken: packet.reconnectToken };
          this.savedSession = this.session; this.sequence = 0; this.direction = null;
          try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session)); } catch {}
        }
        if (packet.type === 'room') { this.room = packet; this.phase = packet.phase; }
        if (packet.type === 'state') this.phase = packet.phase;
        if (['replaced', 'closed', 'left'].includes(packet.type)) this.forget();
        if (packet.type === 'replaced') this.intentional = true;
        if (packet.type === 'error') {
          if (['reconnect_expired', 'room_not_found'].includes(packet.code)) this.forget();
          this.onError(packet);
        }
        this.onMessage(packet);
      };
      socket.onerror = () => {};
      socket.onclose = event => {
        clearTimeout(timeout);
        reject(new Error('Соединение с сервером прервано.'));
        if (this.socket !== socket) return;
        this.connectPromise = null; this.socket = null; this.direction = null;
        this.onStatus(this.intentional ? 'disconnected' : this.session ? 'reconnecting' : 'disconnected');
        if (!this.intentional && this.session && event.code !== 4001) {
          const delay = Math.min(4000, 500 * 2 ** this.retry++);
          this.retryTimer = setTimeout(() => this.connect().catch(() => {}), delay);
        }
      };
    });
    return this.connectPromise;
  }
  send(packet) { if (this.connected) { this.socket.send(JSON.stringify(packet)); return true; } return false; }
  async create(payload = {}) {
    if (this.session) this.send({ type: 'leave' }); this.forget();
    await this.connect(); this.send({ type: 'create', nickname: payload.nickname, characterId: payload.characterId });
  }
  async join(payload = {}) {
    const roomId = String(payload.roomId || '').trim().toUpperCase();
    const previous = this.savedSession?.roomId === roomId ? this.savedSession : null;
    if (this.session && this.session.roomId !== roomId) { this.send({ type: 'leave' }); this.forget(); }
    await this.connect(); this.send({ type: 'join', roomId, nickname: payload.nickname, characterId: payload.characterId,
      reconnectToken: payload.reconnectToken || previous?.reconnectToken });
  }
  select(payload) { this.send({ type: 'select', ...payload }); }
  start() { this.send({ type: 'start' }); }
  returnLobby() { this.direction = null; this.send({ type: 'returnLobby' }); }
  input(dir) {
    if (dir !== null && (!Number.isInteger(dir) || dir < 0 || dir > 3)) return;
    const changed = this.direction !== dir; this.direction = dir;
    if (changed || Date.now() - this.lastInputAt >= 200) this.sendInput();
  }
  sendInput() { if (this.phase !== 'playing') return; if (this.send({ type: 'input', seq: ++this.sequence, dir: this.direction })) this.lastInputAt = Date.now(); }
  bomb() { if (this.phase === 'playing') this.send({ type: 'bomb', seq: ++this.sequence }); }
  forget() { this.session = null; this.savedSession = null; this.room = null; this.phase = null; this.direction = null; try { sessionStorage.removeItem(SESSION_KEY); } catch {} }
  leave() { this.send({ type: 'leave' }); this.forget(); this.close(); }
  close() { this.intentional = true; clearTimeout(this.retryTimer); this.socket?.close(1000, 'Left room'); this.socket = null; this.connectPromise = null; }
  destroy() { this.leave(); clearInterval(this.pulse); }
}
