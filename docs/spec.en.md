[日本語](spec.md)

> This is an English overview of [spec.md](spec.md) as of commit dfe60fe. It is not a full translation: the full specification exists only in Japanese, in [docs/spec.md](spec.md). If they differ, the Japanese version is authoritative.

# Internal design specification (overview)

[docs/spec.md](spec.md) describes how Nostr-Rating works, the rules of the calculation, and how this implementation realizes them.

- Sections that are rules (those not marked "この実装" (this implementation)) are what clients and snapshot generation must follow to get the same result from the same events. Other implementations follow them too.
- Sections marked "この実装" describe the current code (`packages/core`, `apps/web`, `scripts/snapshot`) and how it keeps the cost down. They may change as long as the results do not.
- Rule values (stages, deadlines, Glicko-2 parameters, rematch weights, seasons, etc.) are defined by each game's definition file ([`configs/<game>.json`](../configs/)). Values in the specification are examples from `smash_sp` unless stated otherwise.
- Display strings in definition files (`name`, `notes`, `sides`, etc.) are either a string or a per-locale object (`{"ja": "…", "en": "…"}`). They are never put in events or snapshots; the language is chosen when displaying ([ADR 0017](adr/0017-localized-text.md)).
- Accounts (KEL, devices, disposable keys, public information) are shared across games. Ratings, match settings, the events from recruitment to reports, and snapshots are separate for each game ([ADR 0010](adr/0010-multiple-games.md)).

## Architecture ([全体の構成](spec.md#全体の構成この実装))

There is no central server. Events live on Nostr relays, and everyone calculates with the same rules. Only the daily settled values (snapshots) are built by GitHub Actions, and anyone can rebuild them byte for byte to check them.

| Location | Holds | Written by | Basis of trust |
|---|---|---|---|
| Relays | KEL, certificate announcements, recruitments, applications, matches, reports, public information, DMs | Players' devices | Event signatures, and the KEL tying keys to the account |
| Repository | TOCs (`snapshots/<game>/season_<N>/<date>.json`), `latest.json` | Actions | History and hash chain, rebuilding and comparing |
| Releases | `players`, `accounts` (16 shards), `kels` (16 shards), `ids`, season parts | Actions | sha256 in the TOC |
| Pages | The app, `snapshots/parts/<sha256>.json`, KEL index, public API, player pages, `api/v1/claims.json` | Actions (pages.yml) | sha256 in the TOC (the public API is a convenience copy) |

## Accounts ([アカウント](spec.md#アカウント))

An account is not a single key but a key event log (KEL), published as kind 3753 events. Device keys are WebCrypto P-256 keys, or schnorr keys held by a NIP-07 extension or NIP-46 signer app. Each day, a device issues a certificate to a disposable session key; app events are signed by that session key and carry `aid` and `cert` tags. Certificates are also announced as kind 3755. Recovery words rotate the account to new devices. Reasons: [ADR 0008](adr/0008-key-event-log.md), [ADR 0016](adr/0016-publisher-cosign.md).

## Events ([イベント](spec.md#イベント))

All custom-kind events carry `["t", "nostr-rating"]`; per-game events also carry `["t", "nostr-rating:<game>"]` and `["game", "<game>"]`. Content is JSON.

| Purpose | kind |
|---|---|
| Key event (KEL) | 3753 |
| Certificate announcement | 3755 |
| Account public information (display name, linked accounts) | 30756 |
| Match settings | 30078 |
| Recruitment | 31751 |
| Application | 3751 |
| Match | 3752 |
| Result report | 3754 |
| Room details and chat | 1059 (NIP-17) |

- Linking to X or GitHub uses the fixed, language-neutral statement `Verifying my Nostr-Rating account: <aid>`.
- Sides are decided by commit-reveal of random values from both players ([ADR 0013](adr/0013-seat-draw.md)).

## Valid matches and settlement ([有効な対戦](spec.md#有効な対戦), [結果の確定](spec.md#結果の確定))

A match is valid only if it answers an application signed by p2 ([ADR 0004](adr/0004-linked-matches.md)). It is settled when the first matching pair of reports exists among all reports ([ADR 0002](adr/0002-settlement.md)), and a cancel from a player who reported win, lose or draw is ignored ([ADR 0015](adr/0015-cancel-after-result.md)). Unsettled matches count toward the manners indicator.

## Rating ([レート計算](spec.md#レート計算))

Glicko-2. Valid matches whose deadline falls in `(previous cutoff, this cutoff]` are evaluated once each, in order of `(created_at, id)` ([ADR 0003](adr/0003-deadline-processing.md)). Only matches between two linked accounts are rated, and repeated matches against the same opponent are weighted down.

## Seasons ([シーズン](spec.md#シーズン))

Seasons are defined by a start time, a length in months and a UTC offset, not by a list ([ADR 0007](adr/0007-seasons.md), [ADR 0012](adr/0012-season-end-deadline.md)). Everyone starts from the initial values each season.

## Snapshots ([スナップショット](spec.md#スナップショット))

Snapshots are split into a TOC and content-addressed parts ([ADR 0011](adr/0011-scale.md)). JSON is serialized deterministically so anyone gets the same bytes. Snapshots also record per-match before/after values ([ADR 0014](adr/0014-match-records.md)).

## Fetching and matchmaking ([取得](spec.md#取得), [マッチング](spec.md#マッチング))

Queries that must be complete use only `authors` or `ids`, because tag queries can be flooded. Matchmaking conditions (rating range, rematches, manners) are checked by both clients and not by the rating calculation ([ADR 0006](adr/0006-client-side-conditions.md)).

For the details, formulas and constants, read [docs/spec.md](spec.md).
