import { describe, it, expect } from '@jest/globals';
import { sendSlackDigest } from './digest-sender.js';

describe('digest-sender', () => {
  describe('sendSlackDigest() — SSRF validation', () => {
    it('rejects non-Slack webhook URLs', async () => {
      await expect(sendSlackDigest('http://evil.com/webhook', { text: 'test' })).rejects.toThrow(
        'Invalid webhook URL: must be a valid https://hooks.slack.com/ URL',
      );
    });

    it('rejects HTTP URLs (requires HTTPS)', async () => {
      await expect(
        sendSlackDigest('http://hooks.slack.com/services/T00/B00/X', { text: 'test' }),
      ).rejects.toThrow('Invalid webhook URL: must be a valid https://hooks.slack.com/ URL');
    });

    it('rejects URLs with wrong domain', async () => {
      await expect(
        sendSlackDigest('https://hooks.slack.net/services/T00/B00/X', { text: 'test' }),
      ).rejects.toThrow('Invalid webhook URL: must be a valid https://hooks.slack.com/ URL');
    });

    it('rejects localhost URLs', async () => {
      await expect(
        sendSlackDigest('https://localhost:8080/webhook', { text: 'test' }),
      ).rejects.toThrow('Invalid webhook URL: must be a valid https://hooks.slack.com/ URL');
    });

    it('rejects internal IP addresses', async () => {
      await expect(
        sendSlackDigest('https://192.168.1.1/webhook', { text: 'test' }),
      ).rejects.toThrow('Invalid webhook URL: must be a valid https://hooks.slack.com/ URL');
    });

    it('accepts Slack webhook URL format', async () => {
      const validUrl =
        'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';

      // Mock fetch to resolve successfully
      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
        }) as Response;

      try {
        await sendSlackDigest(validUrl, { text: 'test' });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('accepts Slack webhook URLs with query parameters', async () => {
      const validUrl = 'https://hooks.slack.com/services/T00/B00/X?param=value';

      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          status: 200,
        }) as Response;

      try {
        await sendSlackDigest(validUrl, { text: 'test' });
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
