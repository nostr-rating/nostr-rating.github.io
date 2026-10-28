import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 画面の下に留まる知らせ（App の .dock）に出す。出ても消えても、上にある要素を動かさない。
 * App の外（画面単体のテスト）では、その場に出す
 */
export function Dock({ children }: { children: ReactNode }) {
  const dock = typeof document !== 'undefined' ? document.getElementById('dock-slot') : null;
  return dock ? createPortal(children, dock) : <>{children}</>;
}
