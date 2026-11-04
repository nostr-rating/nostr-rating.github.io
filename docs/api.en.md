[日本語](api.md)

> This is a translation of [api.md](api.md) as of commit dfe60fe. If they differ, the Japanese version is authoritative.

# Public API

An API for reading Nostr-Rating's settled ratings from other sites and tools. There is no server: static JSON files built from the daily snapshot are served on GitHub Pages.

## Location

The files are under `api/v1/` at the same place as the app. Ratings are separate for each game, so the files are split by game id (`smash_sp`, `chess`, etc., as listed in `configs/games.json`).

```
https://nostr-rating.github.io/api/v1/
```

For a forked app, they are under `api/v1/` at that app's URL.

GitHub Pages returns `Access-Control-Allow-Origin: *`, so the files can be read directly from browsers and servers.

## Files

| Path | Contents |
|---|---|
| `index.json` | List of games. `{"games": [{id, name, names, season, players, snapshot}, …]}` |
| `<game>/index.json` | The game's `game` (`id`, `name`, `names`), the snapshot it is built from (`snapshot`), the season, and the number of players |
| `<game>/players/<aid>.json` | One player (see "Player fields" below) |
| `<game>/by/x/<username>.json` | Lookup by X username. `{"players": [player, …]}` |
| `<game>/by/github/<username>.json` | Lookup by GitHub username. Same shape as above |
| `claims.json` | Results of link verification (`"<aid>:<platform>:<lowercase username>:<proof>"` → `{verified, at}`). Reused by the next rebuild |

- Only people with match records in that game are listed. People who only created an account, or who only played other games, get 404.

- Usernames in `by/` are lowercased.
- `by/` lists only links whose post or Gist could be verified. Verification results are reused for 7 days, so a link stays listed for a while after the post or Gist is deleted.
- If someone linked the same external account to several accounts, `players` contains all of them, ordered by number of matches, most first.
- If nothing is found, 404 is returned.
- `name` is the existing field and holds the Japanese name. Use `names` for names in other languages.

## Player fields

| Field | Contents |
|---|---|
| `game` | The game's `id`, `name` (Japanese name), and `names` (names per language, `{"ja": "…", "en": "…"}`) |
| `aid` | Account identifier |
| `name` | Display name (chosen by the player) |
| `season` | Season number |
| `rating`, `rd`, `peak_rating` | Settled rating for the current season, the width of its confidence interval, and peak rating |
| `matches`, `wins`, `losses`, `draws` | Matches, wins/losses, and draws in the current season (always 0 for games without draws) |
| `manners` | Number of no-reports, cancels and disagreements |
| `accounts` | Linked external accounts: `platform` (`twitter` or `github`), `identity`, `proof_url`, `verified` |
| `past_seasons` | Results of finished seasons: `final_rating`, `peak_rating`, `matches`, `wins`, `losses`, `draws` per season number |
| `linked_accounts` | Other accounts linked to the same X or GitHub account (such as an account from before the recovery words were lost and the account recreated). Only those whose links could be verified on both sides, with `aid`, `name`, `via` (the shared external account), and `past_seasons` |
| `snapshot` | `path`, `sha256` and `cutoff` of the snapshot it is built from |

## Usage

On a site where users are already logged in with X or GitHub, look up `by/` with that username to show ratings without handling Nostr.

```js
const res = await fetch(`https://nostr-rating.github.io/api/v1/smash_sp/by/x/${name.toLowerCase()}.json`);
if (res.ok) {
  const { players } = await res.json();
  console.log(players[0].rating);
}
```

The division of roles is: the site's login confirms the person's identity, and this API confirms the tie between the external account and the account.

## Notes

- Updates happen once a day. A snapshot is built every day at 05:00 (Japan time), and the API is rebuilt afterwards. Fetch about once a day and cache the result locally.
- Only settled ratings past the deadline are included. Provisional values shown in the app before the deadline are not.
- If someone changes their X username, they cannot be looked up by the new name until the next rebuild.
- GitHub Pages has a bandwidth guideline. Do not fetch repeatedly at short intervals.

## How to verify

API values are built from the snapshots in the public repository. Fetch the file at `snapshot.path` and check that its sha256 equals `snapshot.sha256` to compare with the original snapshot. Anyone can rebuild and check the snapshot itself from the events on relays ([spec.md](spec.md), Japanese).

How the rating changed in a single match can be checked with the part the TOC's `parts.matches` points to (`snapshots/parts/<sha256>.json`). For each match evaluated in that run, this part holds the values before and after the match, the number of inactive periods, and the rematch weight. The update for one match can be recomputed from the record alone, without recomputing everything (spec.md, "対戦ごとの記録" (per-match records)).

## Player pages

`p/<aid>.html` is a static page per player. When posted on X it is shown as a card, and it shows the rating and record for each game played, linked accounts, and the snapshot it is based on.
