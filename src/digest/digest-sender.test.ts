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

    it('rejects a malformed URL with no parseable scheme', async () => {
      await expect(sendSlackDigest('not-a-url-at-all', { text: 'test' })).rejects.toThrow(
        'Invalid webhook URL: must be a valid https://hooks.slack.com/ URL',
      );
    });

    it('rejects when Slack responds with a non-2xx status', async () => {
      const validUrl = 'https://hooks.slack.com/services/T00/B00/X';

      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: false,
          status: 500,
        }) as Response;

      try {
        await expect(sendSlackDigest(validUrl, { text: 'test' })).rejects.toThrow(
          'Slack webhook returned 500',
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('sendSlackDigest() — redirects', () => {
    const webhookUrl = 'https://hooks.slack.com/services/T000/B000/pf-verify-fake';

    function redirectAwareFetch(): typeof fetch {
      return (async (_url: unknown, init?: RequestInit) => {
        if (init?.redirect === 'manual') {
          return {
            ok: false,
            status: 302,
            headers: new Headers({ location: 'https://api.slack.com/' }),
          };
        }
        return { ok: true, status: 200, headers: new Headers() };
      }) as unknown as typeof fetch;
    }

    it('rejects a redirect without leaking the webhook path', async () => {
      const originalFetch = global.fetch;
      global.fetch = redirectAwareFetch();
      try {
        const err = await sendSlackDigest(webhookUrl, { text: 'x' }).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err).not.toBeNull();
        expect(err?.message).toMatch(/invalid or revoked/);
        expect(err?.message).not.toContain('pf-verify-fake');
        expect(err?.message).not.toContain('T000');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it.each([
      [300, /invalid or revoked/],
      [301, /invalid or revoked/],
      [399, /invalid or revoked/],
      [400, /^Slack webhook returned 400$/],
      [404, /^Slack webhook returned 404$/],
    ])('reports status %i with the matching message', async (status, message) => {
      const originalFetch = global.fetch;
      global.fetch = (async () => ({ ok: false, status })) as unknown as typeof fetch;
      try {
        await expect(sendSlackDigest(webhookUrl, { text: 'x' })).rejects.toThrow(message);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('still resolves on a real 200', async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
      try {
        await expect(sendSlackDigest(webhookUrl, { text: 'x' })).resolves.toBeUndefined();
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
