import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

/** カメラで QR コードを読み取る。accept が true を返した文字列で onResult を呼ぶ */
export function QrScanner({ accept, onResult, onClose }: { accept(text: string): boolean; onResult(text: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

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
      setError('このブラウザではカメラを使えません。申請の文字列をコピーして貼り付けてください。');
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
      .catch(() => setError('カメラを使えませんでした。ブラウザの設定でカメラを許可するか、申請の文字列を貼り付けてください。'));

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
      {error ? <p className="error" role="alert">{error}</p> : <video ref={video} className="scanner" playsInline muted />}
      <button type="button" onClick={onClose}>
        読み取りをやめる
      </button>
    </div>
  );
}
