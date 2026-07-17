import { describe, it, expect } from '@jest/globals';
import { shouldForwardHeader } from './types.js';

describe('shouldForwardHeader', () => {
  describe('spoofable client-trust headers', () => {
    it.each(['x-forwarded-for', 'x-forwarded-host', 'x-real-ip'])('blocks %s', (header) => {
      expect(shouldForwardHeader(header)).toBe(false);
    });

    it.each(['X-Forwarded-For', 'X-Forwarded-Host', 'X-Real-Ip', 'X-REAL-IP'])(
      'blocks mixed-case variant %s',
      (header) => {
        expect(shouldForwardHeader(header)).toBe(false);
      },
    );
  });

  describe('explicitly allowed headers', () => {
    it.each(['content-type', 'accept', 'authorization', 'mcp-session-id'])(
      'forwards %s',
      (header) => {
        expect(shouldForwardHeader(header)).toBe(true);
      },
    );

    it.each(['Content-Type', 'Authorization', 'MCP-Session-Id'])(
      'forwards mixed-case variant %s',
      (header) => {
        expect(shouldForwardHeader(header)).toBe(true);
      },
    );
  });

  describe('other x-* headers', () => {
    it.each(['x-custom', 'x-request-id', 'X-Custom-Header'])('forwards %s', (header) => {
      expect(shouldForwardHeader(header)).toBe(true);
    });
  });

  describe('headers not on any allowlist', () => {
    it.each(['host', 'cookie', 'user-agent', 'connection'])('blocks %s', (header) => {
      expect(shouldForwardHeader(header)).toBe(false);
    });
  });
});
