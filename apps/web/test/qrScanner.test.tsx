import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { QrScanner } from '../src/components/QrScanner.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('QrScanner', () => {
  test('turns the camera off when it is closed before the camera starts', async () => {
    let grant!: (s: MediaStream) => void;
    const stop = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise<MediaStream>((r) => (grant = r)) } });
    const view = render(<QrScanner accept={() => true} onResult={() => undefined} onClose={() => undefined} />);
    view.unmount();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });
});
