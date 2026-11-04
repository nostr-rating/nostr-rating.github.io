# 設計判断の記録（ADR）

設計上の大きな判断を、1件1ファイルで残します。

- 書いたファイルはあとから書き換えません。判断を変えるときは新しい ADR を足し、古い ADR の「状態」を「置き換え（00NN）」にだけ変えます。
- ファイル名は `00NN-短い名前.md` です。項目は「状態」「背景」「決定」「影響」です。

## 一覧

各 ADR の日本語の題と、英語の要約です。

| ADR | 題 | Summary (English) |
|---|---|---|
| [0001](0001-nostr.md) | 通信と署名に Nostr を使う | Use Nostr events, public relays and secp256k1 keys instead of our own server; room details go by NIP-17 encrypted DM. |
| [0002](0002-settlement.md) | 結果は、噛み合う報告の組が初めてそろった時点で確定する | A match is settled when the first matching pair of reports exists among all reports, so backdated reports cannot overturn it. |
| [0003](0003-deadline-processing.md) | 対戦は締め切りを基準に、1回だけ評価する | Each match is evaluated exactly once, in the snapshot whose range contains its report deadline, ordered by creation time and id. |
| [0004](0004-linked-matches.md) | 対戦は、p2 の申し込みに結び付いたものだけを有効にする | A match is valid only if it answers an application signed by p2 within the waiting time, so no one can drag others into matches. |
| [0005](0005-snapshots.md) | レートのスナップショットを GitHub に置き、誰でも再計算できる形にする | Publish deterministic, hash-chained rating snapshots on GitHub so anyone can recompute and detect tampering. |
| [0006](0006-client-side-conditions.md) | マッチの条件はクライアントで判定し、レート計算では確かめない | Rating-range, rematch and manners conditions are checked by both clients, not by the rating calculation. |
| [0007](0007-seasons.md) | シーズンは一覧ではなく、起点と長さで決める | Seasons are defined by a start time and length instead of a list, so they continue without anyone updating them. |
| [0008](0008-key-event-log.md) | アカウントを鍵の出来事の記録（KEL）で表す | An account is a key event log: non-extractable device keys, daily disposable keys with certificates, and recovery words for rotation. |
| [0009](0009-daily-snapshots.md) | スナップショットを GitHub Actions で毎日作る | GitHub Actions builds and commits snapshots every day, so they keep coming without manual work. |
| [0010](0010-multiple-games.md) | 複数のゲームを1つのアプリで扱う | One app handles several games through definition files; accounts are shared, while ratings, seasons and snapshots are per game. Chess is added with draws and invite links. |
| [0011](0011-scale.md) | 人数と対戦が増えても、集計と同期が回るようにする | Split snapshots into a TOC and content-addressed parts and cut repeated verification and queries, so generation and sync scale. |
| [0012](0012-season-end-deadline.md) | シーズンの終わりの直前も対戦でき、締め切りをシーズンの終わりで切る | Matches are allowed right up to the end of a season; their report deadline is cut at the season's end. |
| [0013](0013-seat-draw.md) | 先後を双方の乱数で決める | Sides are decided by commit-reveal of random values from both players, so neither can choose a side. |
| [0014](0014-match-records.md) | 評価した対戦ごとの記録をスナップショットに残す | Snapshots record before/after values for each evaluated match, so a single update can be checked from the record alone. |
| [0015](0015-cancel-after-result.md) | 勝ち・負け・引き分けを報告した人の中止は数えない | A cancel from a player who reported win, lose or draw is ignored, so a backdated cancel cannot undo a settled result. |
| [0016](0016-publisher-cosign.md) | 署名アプリに任せた端末の署名には、掲載用の鍵の署名も要る | KEL entries and certificates signed by a device key held in a signer app also need a signature by the publishing key, so other sites cannot misuse signing requests. |
| [0017](0017-localized-text.md) | 表示の文字列を言語ごとに持つ | Display strings in definition files are a string or a per-locale object; events and snapshots carry only language-neutral values, and UI text is kept per locale next to each component. |
