import { describe, expect, test } from 'vitest';
import { resolveRelayUrl } from '../src/services/config.js';

describe('resolveRelayUrl', () => {
  test('a path is resolved against the page origin, as wss on https and ws on http', () => {
    expect(resolveRelayUrl('/relay', 'https://192.168.1.20:5173')).toBe('wss://192.168.1.20:5173/relay');
    expect(resolveRelayUrl('/relay', 'http://localhost:5173')).toBe('ws://localhost:5173/relay');
  });

  test('a full URL is kept as it is', () => {
    expect(resolveRelayUrl('ws://localhost:7777', 'https://192.168.1.20:5173')).toBe('ws://localhost:7777');
    expect(resolveRelayUrl('wss://relay.example', 'https://192.168.1.20:5173')).toBe('wss://relay.example');
  });
});
