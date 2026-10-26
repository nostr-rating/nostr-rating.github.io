# relay-server

開発・動作確認用のローカル Nostr リレーです。リレーは自作せず、既存の実装
[nostr-rs-relay](https://sr.ht/~gheartsfield/nostr-rs-relay/) をそのまま使います。

```bash
npm run relay:up     # ws://localhost:7777 で起動
npm run relay:down   # 停止（データは Docker ボリューム relay-data に残る）
```

本番では、`configs/relays.json` に載っている公開リレーを使います。
