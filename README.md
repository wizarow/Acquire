# Acquire

Hidden items. Anonymous writers. Catch them all.

Three builds from one source (`src/app.html`):

| Build | File | Needs a server | For |
|---|---|---|---|
| **Online** | `public/index.html` + `server.js` | Yes (Node) | Friends on their own phones, real rooms |
| **Demo** | `dist/acquire-demo.html` | No | The online screens on an in-page room, to try changes before uploading. A bar on top switches between players' phones. Not deployed |
| **Local** | `dist/acquire-local.html` | No | One phone passed around. Paste as a Claude artifact or open the file |

`node build.js` regenerates both. Edit `src/app.html`, never the outputs.

## How a game runs (online)

1. Someone starts a room and shares the code or link. Everyone joins.
2. One player taps **I'll host**. First tap wins; a second claim is refused (`host_taken`). The host picks words (default 4), SFW or NSFW and a category, then starts. **Answers** (Everyone sees / Host only) lives in Settings, the gear on the name pill, until the round starts.
3. Everyone writes and locks one answer. Nobody sees any answer, the host included.
4. The host reveals. Answers appear shuffled, no names. The host reads them out twice, then taps **Hide all**: answers disappear on every phone (the server stops sending them, not just the UI). **Show all** brings them back.
   - **Host only** mode: only the host's phone gets the answers (other phones show cover cards; the server never sends them). The host reads them out and the room has to remember. The host has just **End round** (no Hide/Show). If the host seat changes hands mid-round, the new host sees the answers and the old one stops seeing them. The setting is chosen in the lobby, is online-only, and is kept for the next round.
5. Acquire: the host asks a player "Did you write [item]?" Yes: acquired. No: that player asks someone else about a different item. Never the same item twice.
6. The host ends the round. The room goes back to "Who won?". The winner taps **I won, I'll host** and picks the next category.

**Names.** Everyone starts with a random codename. In the lobby, or in Settings at any time, a player can type their own name (16 characters, a clash gets " 2"). Blank goes back to the random one. The last name and the 5 most recent are kept in that phone's `localStorage` (`acq_name`, `acq_names`) and the last name is applied when joining a room. Nothing about names is stored on the server beyond the room.

**Settings** (gear on the name pill, and top-right on the home screen). For everyone: name, text size (Normal, Large, Larger, Huge) and a colour scheme (Classic, Midnight, Paper, Mint, High contrast), saved per device (`acq_ui`). NSFW rooms always stay plum. For the host: Answers (lobby only) and **Remove a player** (any phase, with a confirm step). A removed player is told, sent home, and that browser tab cannot rejoin the room. If the round is not revealed yet their answer goes with them; after the reveal the cards stay.

Local mode is the same game on one phone: set the players, pass the phone, each player types and locks, then reveal / hide / end round.

Categories are mandatory: Recommended or My own. Choosing NSFW (18+ confirm) switches the suggestions to the NSFW list and the screen to plum.

## Dropping and rejoining (online)

- Same tab, refresh or sleep: the tab keeps its id and slides back into the same codename. The live stream re-subscribes after the phone wakes.
- New tab or device: opening the link shows the codenames that are offline ("Were you already in?"). Tap yours to take it over, locked answer and host seat included. The home page also offers **Rejoin room ABCD** for 6 hours (`localStorage`: room code and codename only).
- Host drops: after 10 s any player can **Take over**. After 45 s the server hands the seat over by itself (in the lobby the seat opens; mid-round the next connected player becomes host).
- A player who joins but never opens the live stream is marked away after 15 s.

## Run the online app

```
node server.js          # Node 18+, no dependencies
# http://localhost:3000
```

| Env var | Default | What |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `TRUST_PROXY` | off | Set `1` behind a proxy/CDN so rate limits use the real client IP |

## Deploy

Needs a host that runs a long-lived Node process and allows streaming responses (Server-Sent Events): **Render, Railway, Fly.io, a VPS**.

**Not Netlify or Vercel.** They serve static files and short serverless functions; rooms live in the server's memory and the live stream stays open, so neither works. (Netlify would need a different backend, for example a hosted realtime service.)

Render: push this folder to a Git repo, then New > Blueprint. `render.yaml` is included. Railway: deploy the repo, it runs `npm start`.

- Put a TLS proxy in front (hosts do this for you) and set `TRUST_PROXY=1`
- Share `https://your-domain/` or a room link `https://your-domain/r/ABCD`
- Run one instance. Rooms are in process memory, so a restart ends live rooms. Free tiers sleep when idle, which also ends live rooms.

## Categories

Online, setup shows the built-in suggestion lists in a fixed order. There is no play-count ranking, no Community picks and no database: the server keeps nothing on disk, so Render's free plan loses nothing on restart or redeploy. Custom ("My own") categories are used for that round only. `GET /api/stats` returns `{ liveRooms }`. In local mode, play counts and community picks are kept in the phone's `localStorage`.

## Privacy

- Entries live in room memory only. They are gone when the round ends or the room closes (6h idle, 30 min empty). Local mode keeps them in the page only.
- Saved forever (online): category name, play count, first/last played, the room code of the last few rooms (to count distinct rooms). Never entries, never codenames.
- The browser keeps a random id in `sessionStorage` (per tab). `localStorage` holds only the last room code and codename. No cookies, no accounts.

## Files

- `server.js`: HTTP + live updates (SSE) + categories store + host-handover timers
- `src/app.html`: the front end source, with `//#if online` / `//#if local` blocks
- `build.js`: writes `public/index.html` (online), `dist/acquire-demo.html` (demo) and `dist/acquire-local.html` (local). Directives: `//#if online | live | demo | local`
- `public/engine.js`: the room state machine, shared by the server and the local build
- `render.yaml`: Render blueprint

## API (online)

`POST /api/rooms` `{pid}` → `{code}` · `GET /api/rooms/:code/info?pid=` (phase + offline codenames) · `POST /api/rooms/:code/join` `{pid, takeover?}` · `POST /api/rooms/:code/act` `{pid, action}` · `GET /api/rooms/:code/events?pid=` (SSE) · `GET /api/health`

`POST /api/rooms` and `/join` also accept an optional `name`. The live stream sends `snapshot`, `tick`, `closed` and, to a removed player, `removed`.

Actions: `claim`, `release`, `settings`, `start`, `submit`, `reveal`, `hide`, `show`, `end`, `rename` `{name}`, `kick` `{alias}` (host only), `leave`.
