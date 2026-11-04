[日本語](CONTRIBUTING.md)

> This is a translation of [CONTRIBUTING.md](CONTRIBUTING.md) as of commit dfe60fe. If they differ, the Japanese version is authoritative.

# How to contribute

This project aims to keep going even if a maintainer leaves. The more people who can send PRs, the less it depends on any particular person.

## Code PRs

1. After `npm install`, make sure `npm run typecheck` and `npm test` pass.
2. For changes to screens or matchmaking, start a local relay with `npm run relay:up` and also run `npm run e2e`.
3. Tests that check text or JSON output must compare the full text, not a substring. Compare large expected values with files in `test/fixtures/`. Do not guess expected values; check the real output once before fixing them.
4. Changes to the rating calculation (`packages/core/src/rating`, `match/settle.ts`) change the results of every client and snapshot. They cannot go in mid-season, so explain the reason and the switch-over timing in the PR description, and update [docs/spec.md](docs/spec.md) in the same PR.
5. When changing a major design decision, add a new record to [docs/adr/](docs/adr/). Existing records are not rewritten.

## Updating the internal design specification

[docs/spec.md](docs/spec.md) describes the mechanisms, the calculation rules, and the implementation that realizes them. In a PR that changes any of the following, update docs/spec.md in the same PR. If nothing needs updating, say so in the PR description.

- Event formats, KEL, certificates, valid matches, settlement, rating calculation, seasons, snapshot format (the "rules" sections)
- Fetching, client sync, matchmaking, efficiency mechanisms, constants (the "this implementation" sections)

Reviews always check that the change and docs/spec.md agree. When a formula uses a new symbol, define it in the table right below the formula.

## PRs adding a relay

Add one line with the URL to `configs/relays.json`. The requirements are:

- Reachable via `wss://`
- Supports NIP-40 (expiration)
- Accepts the kinds listed under "アカウント" (accounts) and "イベント" (events) in [docs/spec.md](docs/spec.md), and supports single-letter tag queries (`#x`, `#n`, `#p`, `#d`, etc.)
- The operator's contact is listed in its NIP-11 information

## Verifying snapshots

GitHub Actions builds snapshots daily, stacks the TOC in `snapshots/`, and stores the parts in Releases ([ADR 0009](docs/adr/0009-daily-snapshots.md), [ADR 0011](docs/adr/0011-scale.md)). Anyone who builds one gets the same bytes, so you can check them like this:

```bash
git checkout <the commit just before the snapshot to check>
npm install
npm run snapshot -- --cutoff <the cutoff of the snapshot to check> --release-base https://github.com/<owner>/<repo>/releases/download/
git diff <the commit of the snapshot to check> -- snapshots/
```

The TOC holds the sha256 of each part, so if the TOC has no diff, the parts are identical too and the snapshot was computed correctly. A diff can appear if your relays hold different events. In that case, compare the part with the event ids used (`parts.ids` in the TOC) between your local `.snapshot-parts/` and the release.

- `cutoff` must be earlier than the time of generation (future times are rejected).
- There is only one snapshot per date (JST).
- If you change values in a game definition (`configs/<game>.json`) that affect the rating calculation (Glicko-2 parameters, rematch weights, deadline, allowed results, seasons), generation for that game stops mid-season.
- After adding a game, until a snapshot exists, the app calculates that game from the start of the current season.

## Language

- The Japanese documents are authoritative. English versions (`*.en.md`) are translations, with the base commit noted at the top. When you change a Japanese document, update the English version too, or say in the PR description that the English version is out of date.
- Code comments, commit messages and PR descriptions are written in Japanese for now. English issues and PRs are welcome.
- UI strings live next to the component that uses them, in `messages({ ja, en })`. Add every language in the same PR (type checking fails if one is missing).
- Display strings in definition files (game name, character and stage names, side names, notes) must be written for every language ([ADR 0017](docs/adr/0017-localized-text.md)).

## Reporting bugs

Open an issue with steps to reproduce and your browser and device. If you have an example of an invalid event, attaching the event JSON helps the investigation. Do not include recovery words or device requests (strings starting with `nr-device:`).

Report problems that could lead to account takeover or impersonation through the process in [SECURITY.en.md](SECURITY.en.md), not as an issue.
