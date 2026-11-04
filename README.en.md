[日本語](README.md)

> This is a translation of [README.md](README.md) as of commit dfe60fe. If they differ, the Japanese version is authoritative.

# Nostr-Rating

Rated matches for 1-on-1 competitive games, with no operator.
Recruiting opponents, reporting results and calculating ratings all happen on [Nostr](https://github.com/nostr-protocol/nips), without a central server.

The rules of each game (characters, stages, match format, report deadline, rating parameters and so on) live in a definition file (`configs/<game>.json`).
Definitions for Super Smash Bros. Ultimate ([`configs/smash_sp.json`](configs/smash_sp.json)) and chess ([`configs/chess.json`](configs/chess.json)) are included, and players choose the game in the app.

The app is available at https://nostr-rating.github.io/.

> **Status:** In development. The specification and storage formats may change without notice.

Nostr-Rating is unofficial software made by volunteers. It is not affiliated with the developers or publishers of the supported games. Game names are trademarks of their respective owners.

## Why we built it

スマメイト, an unofficial rated-match site for Super Smash Bros. Ultimate, shut down on October 25, 2026.
When the operator leaves, a service cannot continue.

Nostr-Rating builds rated matches that do not depend on an operator, based on two ideas.

1. **Guarantee safety by not trying to protect information.**
   There is no personal information to protect and no secret database. Every match result is published with the player's own signature, and anyone can verify it.
2. **Keep running without an operator.**
   The system runs on its mechanisms alone, so it does not stop when a particular person or server disappears. All code and procedures are public so that maintainers can be replaced.

## How it works

```
 ┌────────────── Browser (served from GitHub Pages) ────────────┐
 │ Web app (React)                                              │
 │   - Keys: device key (WebCrypto) and a disposable daily key  │
 │   - Local cache: SQLite (OPFS)                               │
 │   - Rating: packages/core (snapshot + delta)                 │
 └──────────┬───────────────────────────────┬──────────────────┘
            │ WebSocket (several relays at once) │ HTTPS
   ┌────────▼────────┐               ┌─────────▼───────────────────┐
   │ Public Nostr relays│              │ GitHub                        │
   │(configs/relays.json)│             │  Pages: snapshots/<game>/    │
   └────────▲────────┘               │  Repository: TOCs, configs/   │
            │                         │  Releases: parts              │
   ┌────────┴────────────────────────┐ └─────────▲───────────────────┘
   │ Snapshot generation (Actions, daily)│─────────┘
   └─────────────────────────────────┘
 Recovery tool (single HTML file): download it from Releases and open it outside the normal app
```

### Data flow

1. **Account:** An account is not a single key but a key event log (KEL). The device key is stored on the device in a non-extractable form,
   and it issues certificates to a disposable key for each day. If a device is lost or stolen, the account can be restored with the "recovery words" written on paper
   ([ADR 0008](docs/adr/0008-key-event-log.md); the user-facing explanation is the app's "Help").
2. **Linking:** The app shows a statement saying "this account is mine", and the player posts it on X or puts it in a GitHub Gist.
   Both are verified automatically. Accounts without a link are not rated, and accounts linked to the same X or GitHub account
   are shown together on the player screen and in the public API. This way, even if one person creates many accounts, they can be recognized as the same person when linked with the same social account.
3. **Recruiting and applying:** When a player presses "Find an opponent", they apply to a matching recruitment or post their own.
   The conditions are rating difference, rematches, and the manners indicator; each client checks them independently.
4. **Match:** The recruiter publishes a match event answering the application (which carries the applicant's signature).
   The sides (P1/P2 in Smash, White/Black in chess) are decided by combining random values from both players ([ADR 0013](docs/adr/0013-seat-draw.md)), and the player on the first side sends the room ID and
   password, or the game's invite link, only to the opponent by encrypted DM (NIP-17 / NIP-44).
5. **Reporting:** Both players report "win / lose / cancel" (and "draw" in games with draws) with their signature. The result is settled as soon as a matching pair exists, and backdated reports added later cannot overturn it. A cancel from a player who reported win, lose or draw is not counted.
6. **Rating:** Ratings are calculated with Glicko-2. Each match is evaluated exactly once, when its report deadline passes, in the order the matches were made.
7. **Snapshots:** GitHub Actions builds a snapshot of every player's rating for each game daily. The table of contents (TOC) is stored in `snapshots/<game>/`, the parts in Releases, and both are served from GitHub Pages ([ADR 0011](docs/adr/0011-scale.md)).
   From the latest snapshot, a client reads only the season's player parts and the KELs of accounts appearing in new events, then adds the later events to calculate. Player pages and the public API for other sites ([docs/api.en.md](docs/api.en.md)) are also built from it.

### Why anyone can verify it

- Matches, applications and reports are all Nostr events signed with a disposable key certified by the player's own device. Third parties cannot create them, and modifying them breaks the signature.
- The calculation is deterministic. The same set of events gives the same result wherever it is computed (regardless of duplicate events, arrival order, or where snapshots are cut).
- A snapshot contains the hash of the list of event IDs used, the hash of the previous snapshot, and the hash of the settings.
- A snapshot also contains the before and after values of each evaluated match. You can check the change from a single match from the records alone, without recomputing everything ([ADR 0014](docs/adr/0014-match-records.md)).
- The sources of snapshots and the relay list can be changed in the app's settings. Even if this repository disappears, a fork works the same way.

The GitHub history is used not to make tampering *impossible* but to make it *detectable*.

## Match rules

Accounts are shared across all games; ratings, match settings, rankings and seasons are separate for each game.
To add a game, write a definition file and add it to [`configs/games.json`](configs/games.json). The app and snapshot generation handle every game in this list.
The shape of a definition and what it can express are described in [ADR 0010](docs/adr/0010-multiple-games.md).

### Super Smash Bros. Ultimate

The format follows the one widely used for online rated matches in Smash Ultimate. All values such as stages and deadlines are in [`configs/smash_sp.json`](configs/smash_sp.json), and the app's match room shows them.

- Best of 3. The P1 player creates the room, and the room ID and password reach only the opponent. P1 and P2 are decided at random for each match
- Room password: P1's device generates a random 4-digit number for each match. It can be changed to 4-8 digits before sending. If a fixed default is set on the settings screen, it is used instead of a random one (the default is stored only on that device and is not published)
- Game 1: each player picks from the stages left after removing both players' banned stages, and the in-game random selection decides
- Game 2 and later: the loser of the previous game picks, and the winner chooses "random". Only the stages the winner banned against the loser's character are removed
- Banned stages: set for each opponent character. Some groups of characters share banned stages
- Character changes: in game 2 and later, only the loser of the previous game may change
- Reports have a deadline. The number of "not reported", "cancelled", and "still disagreeing at the deadline" outcomes is counted as the "manners indicator", reset every season. Players whose counts differ a lot are not matched

### Chess

Included as a second game with different characteristics. Values are in [`configs/chess.json`](configs/chess.json).

- One game decides the result. Draws are possible
- Time control is 15 minutes + 10 seconds per move (the same as the World Rapid Championship of the International Chess Federation)
- Games are played on an online chess service both players can use. The White player creates and sends an invite link, and the Black player checks the link's host name before opening it. The app does not decide which service to use
- White and Black are decided at random for each match. The report deadline and manners indicator are the same as in Smash Ultimate

## Known limitations

The current system does not prevent the following.

- With prepared keys, wins can be faked between throwaway accounts. Being "linked" (which makes an account rated) only requires the link to be written correctly; it does not check that the person really owns that social account. This is only mitigated by lowering the weight of repeated matches against the same opponent in a short time and by the match conditions.
- The same X or GitHub account can be linked to many accounts. This is not blocked; they are only shown side by side on the player screen and in the public API.
- When results disagree, we cannot tell who lied. Both players are counted.
- X links are verified with X's embedding API (oEmbed). If X stops this API, links can no longer be verified.
- If the served JavaScript is replaced, the device key can be used while the page is open. The key itself is not taken out, and the account can be restored with the recovery words, but match results until the device is revoked (up to about one day) may remain.
- Likewise, a single page load is enough for certificates of each day's disposable key, up to the device's expiry (up to 90 days), to be created in advance. This leaves no trace in the KEL, so it cannot be noticed. Revoking the device or rotating with the recovery words makes certificates for later days unusable.
- On GitHub Pages, all Pages sites of the same owner share the same origin (`<owner>.github.io`). JavaScript from other sites could use the device key. For this reason, the app is served from a dedicated organization (`nostr-rating`). If you fork and publish it, serve it from your own domain or from an account dedicated to this app.
- The "first seen version" of a KEL is decided by whoever builds the snapshot. Anyone can rebuild and check it, but this part is centralized.
- For an account that published more than 300 events in a single second, its reports and links for that run are not used, and its matches are settled as the opponent reported. In that run, matches of accounts linked for the first time and matches that cannot be checked against recorded KELs are not counted.
- Matches between accounts not yet known may be missed during an attack. In snapshots, once either side plays a known account, they are no longer missed. In the app's provisional display before the deadline, matches of known accounts may also be missed.
- `created_at` is chosen by the author. Deadline checks are not perfect.
- Public relays do not keep events forever. Rechecking old matches relies on the snapshots and the event ID lists.
- An account's public information (kind 30756) is a replaceable event. When updated, the old version is gone, and past snapshots can no longer be fully recomputed.
- The results of `Math.exp`/`Math.log` may differ in the last bits between browsers. Values are rounded to 6 decimal places to absorb this, but a rare mismatch is still possible. The snapshot is authoritative.
- If a match arrives just after the applicant's wait times out, a match that only one side thinks was made can remain. If neither reports, it counts for neither.
- A report, once sent, cannot be withdrawn, and stays valid even if another is sent. If the opponent matches a mistaken report, the result is settled that way.
- Even after a pair of cancels exists, if either player sends win, lose or draw, that player's cancel is no longer counted. If the opponent does not match it, it becomes a disagreement at the deadline. If it is sent backdated after the deadline but before the snapshot is built, the opponent cannot match it. Only the category in the manners indicator changes; neither the manners indicator total nor the ratings change.
- Disrupting matchmaking by posting many recruitments or applications is only mitigated by range checks and a limit on the number of applications.
- On each sync, a client reads the season's player parts (about 0.7 KB per player, about 0.2 KB gzipped) and the KELs of accounts active in the last 2-3 days (about 1-2 KB per player). Both are reread on the first sync of each day, when their content changes. If a season has more than tens of thousands of players, or more than thousands of accounts are active every day, that sync reads tens of MB before compression.
- Snapshots are served from GitHub Pages. Pages has a bandwidth guideline (100 GB per month) and a site size limit (1 GB). KEL parts alone reach the site limit at about 500,000 accounts in total.
- In matchmaking, each waiting player reads everyone's recruitments every few seconds. The amount relays return grows with the square of the number of waiting players, and beyond the relay's per-request limit, some candidates become invisible.

## Running locally

You need Node.js 22 or later and Docker (GitHub Actions runs Node.js 24).

```bash
npm install
npm run relay:up                 # start a local relay at ws://localhost:7777
npm run dev                      # web app (connected to the local relay)
```

Open the shown URL in two separate windows (one in a private window) to play against yourself.

If there is no snapshot, the dev server calculates from the start of the current season. To build a snapshot locally and load it, write it out like this:

```bash
npm run snapshot -- --cutoff "$(date +%s)" --relays ws://localhost:7777
npm run site -- --out .snapshot-parts/site --app-url http://localhost:5173/
```

`npm run snapshot` writes the TOC to the repository's `snapshots/`. Do not commit TOCs you made for testing.

### Testing on a phone

To open the app from a phone on the same LAN, use this instead of `npm run dev`:

```bash
npm run relay:up
npm run dev:lan                  # serve over https on the LAN and proxy /relay to the local relay
```

Open the `Network:` URL that is shown (such as `https://192.168.x.x:5173/`) on the phone.

- The device key (WebCrypto) and record storage (OPFS) only work over https, so a self-signed certificate is used. The first time, a warning such as "Your connection is not private" appears; proceed from the details.
- The phone connects to the relay through `/relay` at the same address as the page. It does not connect directly to port 7777 on the development machine.
- Safari on iPhone may fail to connect to the relay with a self-signed certificate. In that case, create a certificate with [mkcert](https://github.com/FiloSottile/mkcert), pass it in, and install and trust mkcert's CA (`rootCA.pem` in `mkcert -CAROOT`) on the phone.

  ```bash
  mkcert -cert-file lan.pem -key-file lan-key.pem <development machine IP> localhost
  NR_LAN_CERT=lan.pem NR_LAN_KEY=lan-key.pem npm run dev:lan
  ```

- Instead of the IP, you can also use the development machine's host name (`<hostname>` or `<hostname>.local`). If you open it under any other name, automatic reload on save does not connect. Pass that name like `NR_LAN_HOSTS=<name> npm run dev:lan`.
- If it cannot connect, allow incoming connections to node in the development machine's firewall.

```bash
npm test                         # unit tests
npm run typecheck                # type check
npm run e2e                      # two-browser E2E (needs the local relay)
npm run snapshot -- --cutoff <UNIX seconds> [--game <game>] [--relays ws://localhost:7777]   # all games if --game is omitted
npm run site -- --out <output dir> --app-url <app URL>   # player pages and public API
npm run recovery:build           # recovery tool (apps/recovery/dist/nostr-rating-recovery.html)
npm run recover                  # CLI version of the recovery tool
```

How to publish the app with your own GitHub account is described in [docs/self-hosting.en.md](docs/self-hosting.en.md).

## Repository layout

| Path | Contents |
|---|---|
| `packages/core` | Core logic independent of the UI (game definitions, stage rules, Glicko-2, events, settlement, matchmaking, snapshots) |
| `apps/web` | Web app (React + Vite) |
| `apps/recovery` | Recovery tool (single HTML file) |
| `scripts/snapshot` | Snapshots, player pages and public API, recovery CLI |
| `configs/` | Relay list, game list and definitions |
| `snapshots/` | TOCs of rating snapshots (per game; parts are in Releases) |
| `relay-server/` | Local relay for development (Docker Compose for nostr-rs-relay) |
| `docs/spec.md` | Internal design specification (event formats, calculation rules, fetching, sync and efficiency); Japanese only, with an English overview in [docs/spec.en.md](docs/spec.en.md) |
| `docs/adr/` | Architecture decision records (Japanese, with English summaries in the index) |
| `docs/self-hosting.md` | How to run the app yourself |
| `docs/api.md` | Public API for reading ratings from other sites |

## Contributing

See [CONTRIBUTING.en.md](CONTRIBUTING.en.md). PRs for code and for adding relays are welcome. Snapshots are built by GitHub Actions, so no PR is needed, but rebuilding and checking them locally is appreciated. The mechanisms, calculation rules and implementation are in [docs/spec.md](docs/spec.md) (internal design specification), and the reasons for design decisions are in [docs/adr/](docs/adr/).

## License

[MIT](LICENSE)
