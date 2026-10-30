import { describe, expect, test } from 'vitest';
import { decodeDeviceRequest, deviceRequestCheck, encodeDeviceRequest, type DeviceRequest } from '../../src/kel/recover.js';

const REQ: DeviceRequest = { key: { type: 'p256', pub: '02' + 'ab'.repeat(32) }, publisher: 'cd'.repeat(32), label: 'スマホ' };

describe('device request', () => {
  test('round-trips through the nr-device: text', () => {
    expect(decodeDeviceRequest(encodeDeviceRequest(REQ))).toEqual(REQ);
  });

  test('the check number depends on the key and the publisher, not on the label', () => {
    expect(deviceRequestCheck(REQ)).toBe('542 153');
    expect(deviceRequestCheck({ ...REQ, label: '別の名前' })).toBe(deviceRequestCheck(REQ));
    expect(deviceRequestCheck({ ...REQ, publisher: 'ce'.repeat(32) })).not.toBe(deviceRequestCheck(REQ));
    expect(deviceRequestCheck({ ...REQ, key: { type: 'p256', pub: '03' + 'ab'.repeat(32) } })).not.toBe(deviceRequestCheck(REQ));
  });
});
