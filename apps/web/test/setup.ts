import 'fake-indexeddb/auto';
import { configure } from '@testing-library/react';

// 画面のテストは日本語の文言で書く。jsdom のブラウザの言語は英語なので、言語を決める前（i18n.ts を読む前）に日本語にしておく
Object.defineProperty(navigator, 'languages', { value: ['ja-JP'], configurable: true });

// 鍵の生成と署名の確認があるので、テストを並べて流すと画面の準備に1秒以上かかることがある
configure({ asyncUtilTimeout: 5000 });
