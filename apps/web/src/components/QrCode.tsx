import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/** 文字列を QR コード（SVG）で表示する */
export function QrCode({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [text]);
  if (!svg) return null;
  // SVG は qrcode が自分の文字列から作ったもので、外から来た HTML ではない
  return <div className="qr" role="img" aria-label={label} data-testid="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}
