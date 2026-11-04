# 公開 API

ほかのサイトやツールから、Nostr-Rating の確定レートを読むための API です。サーバーはなく、毎日のスナップショットから作った静的な JSON ファイルを GitHub Pages で配っています。

## 置き場所

アプリと同じ場所の `api/v1/` の下にあります。レートはゲームごとに別なので、ゲームの id（`configs/games.json` にある `smash_sp`、`chess` など）ごとに分けて置いています。

```
https://nostr-rating.github.io/api/v1/
```

fork して動かしているアプリでは、そのアプリの URL の下の `api/v1/` にあります。

GitHub Pages は `Access-Control-Allow-Origin: *` を返すので、ブラウザからもサーバーからも直接読めます。

## ファイル

| パス | 中身 |
|---|---|
| `index.json` | ゲームの一覧。`{"games": [{id, name, season, players, snapshot}, …]}` |
| `<ゲーム>/index.json` | そのゲームの `game`（`id` と `name`）、元にしたスナップショット（`snapshot`）、シーズン、選手の数 |
| `<ゲーム>/players/<aid>.json` | 選手1人分（下の「選手の項目」） |
| `<ゲーム>/by/x/<ユーザー名>.json` | X のユーザー名から引く。`{"players": [選手, …]}` |
| `<ゲーム>/by/github/<ユーザー名>.json` | GitHub のユーザー名から引く。形は上と同じ |
| `claims.json` | 紐づけを確かめた結果（`"<aid>:<platform>:<小文字のユーザー名>:<proof>"` → `{verified, at}`）。次の作り直しで使い回す |

- 載るのは、そのゲームで対戦の記録がある人だけです。アカウントを作っただけの人や、別のゲームだけで対戦している人は 404 になります。

- `by/` のユーザー名は小文字にします。
- `by/` には、投稿や Gist を確かめられた紐づけだけが載ります。確かめた結果は7日間使い回すので、投稿や Gist を消しても、しばらくは載ったままです。
- 同じ外部アカウントを複数のアカウントに紐づけた人は、`players` に対戦数の多い順ですべて入ります。
- 見つからないときは 404 が返ります。

## 選手の項目

| 項目 | 内容 |
|---|---|
| `game` | ゲームの `id` と `name` |
| `aid` | アカウントの識別子 |
| `name` | 表示名（本人が決めた値） |
| `season` | シーズンの番号 |
| `rating`、`rd`、`peak_rating` | 今のシーズンの確定レート、その信頼区間の幅、最高レート |
| `matches`、`wins`、`losses`、`draws` | 今のシーズンの対戦数、勝敗、引き分けの数（引き分けのないゲームでは常に 0） |
| `manners` | 未報告・中止・食い違いの回数 |
| `accounts` | 紐づけた外部アカウント。`platform`（`twitter` か `github`）、`identity`、`proof_url`、`verified` |
| `past_seasons` | 終わったシーズンの成績。シーズンの番号ごとに `final_rating`、`peak_rating`、`matches`、`wins`、`losses`、`draws` |
| `linked_accounts` | 同じ X か GitHub を紐づけた別のアカウント（復活の言葉を失くして作り直す前のアカウントなど）。双方の紐づけを確かめられたものだけで、`aid`、`name`、`via`（共通の外部アカウント）、`past_seasons` を持つ |
| `snapshot` | 元にしたスナップショットの `path`、`sha256`、`cutoff` |

## 使い方

利用者がすでに X か GitHub でログインしているサイトなら、そのユーザー名で `by/` を引けば、Nostr を扱わずにレートを表示できます。

```js
const res = await fetch(`https://nostr-rating.github.io/api/v1/smash_sp/by/x/${name.toLowerCase()}.json`);
if (res.ok) {
  const { players } = await res.json();
  console.log(players[0].rating);
}
```

本人であることはそのサイトのログインが確かめ、外部アカウントとアカウントの結び付きはこの API が確かめる、という分担です。

## 注意

- 更新は1日1回です。毎日 05:00（日本時間）にスナップショットを作り、そのあと API を作り直します。読む側も1日1回ほど取得し、手元にキャッシュしてください。
- 載るのは締め切りを過ぎた確定レートだけです。アプリに出る締め切り前の暫定値は含みません。
- X のユーザー名を変えた人は、次の作り直しまで、新しい名前では引けません。
- GitHub Pages には転送量の目安があります。短い間隔で繰り返し取得しないでください。

## 確かめ方

API の値は公開リポジトリのスナップショットから作っています。`snapshot.path` のファイルを取得し、その sha256 が `snapshot.sha256` と同じかを見れば、元のスナップショットと照らせます。スナップショット自体もリレーにあるイベントから誰でも作り直して確かめられます（[spec.md](spec.md)）。

1つの対戦でレートがどう変わったかは、目次の `parts.matches` が指す部品（`snapshots/parts/<sha256>.json`）で確かめられます。この部品は、その回に評価した対戦ごとに、対戦の前と後の値、休んでいた期間の数、連戦の重みを持ちます。全体を計算し直さなくても、記録だけで1つの対戦の更新を計算し直せます（spec.md「対戦ごとの記録」）。

## 選手ページ

`p/<aid>.html` は選手ごとの静的なページです。X に貼るとカードとして表示され、対戦したゲームごとのレートと戦績、紐づけたアカウント、根拠のスナップショットが載っています。
