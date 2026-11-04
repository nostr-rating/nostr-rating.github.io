import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';
import { messages, useT } from '../i18n.js';

const M = messages({
  ja: {
    unsupported: 'このブラウザではカメラを使えません。申請の文字列をコピーして貼り付けてください。',
    denied: 'カメラを使えませんでした。ブラウザの設定でカメラを許可するか、申請の文字列を貼り付けてください。',
    stop: '読み取りをやめる',
  },
  en: {
    unsupported: 'This browser cannot use the camera. Copy the request text and paste it instead.',
    denied: 'Could not use the camera. Allow camera access in your browser settings, or paste the request text.',
    stop: 'Stop scanning',
  },
});

/** カメラで QR コードを読み取る。accept が true を返した文字列で onResult を呼ぶ */
export function QrScanner({ accept, onResult, onClose }: { accept(text: string): boolean; onResult(text: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const t = useT(M);
  // 言語を切り替えても描き直せるよう、文言ではなく理由を持つ
  const [error, setError] = useState<'unsupported' | 'denied' | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let alive = true;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      const v = video.current;
      if (!alive || !v || !ctx) return;
      if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (code && accept(code.data)) {
          onResult(code.data);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('unsupported');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        stream = s;
        // 許可を待つ間に閉じられていたら、点いたカメラをすぐ消す
        if (!alive || !video.current) return s.getTracks().forEach((t) => t.stop());
        video.current.srcObject = s;
        await video.current.play();
        frame = requestAnimationFrame(tick);
      })
      .catch(() => setError('denied'));

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // 読み取りは1回だけ始める
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="stack">
      {error ? <p className="error" role="alert">{t[error]}</p> : <video ref={video} className="scanner" playsInline muted />}
      <button type="button" onClick={onClose}>
        {t.stop}
      </button>
    </div>
  );
}
