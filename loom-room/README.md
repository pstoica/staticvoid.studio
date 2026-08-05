# loom-room

A ~100-line Cloudflare Worker that backs **rooms** for Loom's shape packs
(`/loom/draw/`): several people draw on their own devices, everyone's packs land in
everyone's Loom.

A room is a **Durable Object**, one instance per room code — `idFromName(code)` means
everybody who types `bananas` lands in the same object. It holds that room's packs and
fans changes out over WebSockets (hibernation API, so it sleeps between messages).

## Deploy

```bash
cd loom-room
npx wrangler deploy
```

First run will ask you to log in and will create the DO namespace. It prints a URL like
`https://loom-room.<your-subdomain>.workers.dev` — paste that into the draw editor's
**room server** field (it's stored per browser, so you only do it once).

Local dev:

```bash
cd loom-room && npx wrangler dev     # ws://localhost:8787/r/<code>
```

## Protocol

Client → server

| message | meaning |
| --- | --- |
| `{ t:"pack", name, pack }` | publish/overwrite a pack (`pack` = `{ frames:[dataURL…], mode }`) |
| `{ t:"drop", name }` | remove a pack from the room |

Server → client

| message | meaning |
| --- | --- |
| `{ t:"state", packs }` | the whole room, sent on connect |
| `{ t:"pack", name, pack }` | someone published (never echoed to the sender) |
| `{ t:"drop", name }` | someone removed one |
| `{ t:"peers", n }` | how many people are connected |

A plain `GET /r/<code>` returns the room as JSON — handy for debugging.

## Limits (public endpoint, so it's bounded)

48 packs per room · 32 frames per pack · 24 KB per frame (a 32×32 PNG dataURL is ~0.5 KB).
Rooms are last-write-wins per pack name and persist in DO storage until overwritten.

## Cost

Effectively free at this scale: DOs bill for requests + active duration, and a drawing
room is idle almost all the time (hibernation means no duration charge while asleep).
