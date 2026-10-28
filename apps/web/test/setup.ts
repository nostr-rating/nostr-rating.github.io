import 'fake-indexeddb/auto';
import { configure } from '@testing-library/react';

// 鍵の生成と署名の確認があるので、テストを並べて流すと画面の準備に1秒以上かかることがある
configure({ asyncUtilTimeout: 5000 });
