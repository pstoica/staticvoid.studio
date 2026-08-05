// loom-room — a tiny Cloudflare Worker + Durable Object that lets several people share
// Loom shape packs live. One DO instance per room code, so a "room" is literally an
// object: it holds the room's packs and fans every change out over WebSockets.
//
// Protocol (JSON both ways):
//   → { t:"pack", name, pack }   publish/overwrite one pack ({ frames:[dataURL…], mode })
//   → { t:"drop", name }         remove a pack from the room
//   ← { t:"state", packs }       full room state, sent on connect
//   ← { t:"pack", name, pack }   someone published (never echoed to the sender)
//   ← { t:"drop", name }
//   ← { t:"peers", n }           how many people are in the room
//
// Deploy:  cd loom-room && npx wrangler deploy
// Dev:     cd loom-room && npx wrangler dev        (ws://localhost:8787/r/<code>)

const MAX_PACKS = 48;              // per room
const MAX_FRAMES = 32;             // per pack
const MAX_FRAME_BYTES = 24 * 1024; // a 32×32 PNG dataURL is ~0.5 KB; this is a generous cap

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // plain GET → a JSON snapshot of the room (handy for debugging / read-only clients)
      const packs = (await this.ctx.storage.get('packs')) || {};
      return new Response(JSON.stringify({ packs, peers: this.ctx.getWebSockets().length }),
        { headers: { 'Content-Type': 'application/json', ...CORS } });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // hibernation API: the DO can sleep between messages and still keep the sockets
    this.ctx.acceptWebSocket(server);
    const packs = (await this.ctx.storage.get('packs')) || {};
    server.send(JSON.stringify({ t: 'state', packs }));
    this.broadcastPeers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'pack') {
      const name = String(msg.name || '').slice(0, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      const pack = sanitizePack(msg.pack);
      if (!name || !pack) return;
      const packs = (await this.ctx.storage.get('packs')) || {};
      if (!(name in packs) && Object.keys(packs).length >= MAX_PACKS) return;   // room full
      packs[name] = pack;
      await this.ctx.storage.put('packs', packs);
      this.broadcast({ t: 'pack', name, pack }, ws);
    } else if (msg.t === 'drop') {
      const name = String(msg.name || '');
      const packs = (await this.ctx.storage.get('packs')) || {};
      if (name in packs) {
        delete packs[name];
        await this.ctx.storage.put('packs', packs);
        this.broadcast({ t: 'drop', name }, ws);
      }
    }
  }

  webSocketClose() { this.broadcastPeers(); }
  webSocketError() { this.broadcastPeers(); }

  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch { /* dropped socket */ }
    }
  }
  broadcastPeers() { this.broadcast({ t: 'peers', n: this.ctx.getWebSockets().length }); }
}

// keep a published pack small and well-formed — this is a public endpoint
function sanitizePack(pack) {
  if (!pack || typeof pack !== 'object') return null;
  const frames = Array.isArray(pack.frames) ? pack.frames.slice(0, MAX_FRAMES) : [];
  const clean = frames.filter((f) => typeof f === 'string'
    && f.startsWith('data:image/') && f.length <= MAX_FRAME_BYTES);
  if (!clean.length) return null;
  const mode = ['pixels', 'rounded', 'metaball'].includes(pack.mode) ? pack.mode : 'pixels';
  return { frames: clean, mode };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const m = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{1,40})$/);
    if (!m) {
      return new Response('loom-room — connect a websocket to /r/<room-code>\n',
        { headers: { 'Content-Type': 'text/plain', ...CORS } });
    }
    // the room CODE is the object id, so everyone typing the same code lands in the
    // same Durable Object — that's the whole room mechanism
    const id = env.ROOMS.idFromName(m[1].toLowerCase());
    return env.ROOMS.get(id).fetch(request);
  },
};
