import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { Agent } from 'undici';
import { createLogger } from '../shared/index.js';
import { validateSsrfUrl, createSsrfSafeLookup } from '../security/ssrf.js';

const logger = createLogger('otlp-receiver');

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_BODY_TIMEOUT_MS = 30_000; // 30 s
const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
const ALLOWED_CONTENT_TYPES = new Set([
  'application/json',
  'application/x-protobuf',
  'application/octet-stream',
]);

class BodyTooLargeError extends Error {}
class RequestTimeoutError extends Error {}
class RateLimitExceededError extends Error {}
class AuthenticationError extends Error {}
class UnsupportedContentTypeError extends Error {}

export interface OtlpReceiverOptions {
  readonly port: number;
  readonly bindAddress?: string;
  readonly forwardEndpoint: string | null;
  readonly forwardHeaders: Record<string, string>;
  readonly enrichmentAttributes: Record<string, string>;
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
  readonly rateLimitPerMinute?: number;
  readonly apiKey?: string;
}

export class OtlpReceiver {
  private readonly options: OtlpReceiverOptions;
  private server: ReturnType<typeof createServer> | null = null;
  private readonly rateLimiter = new Map<string, number[]>();
  // Built once and reused for every forward() call. Its connect.lookup resolves and
  // validates the address actually connected to — see createSsrfSafeLookup()'s doc
  // comment. undefined when forwarding is disabled (nothing to protect).
  private readonly forwardDispatcher: Agent | undefined;

  constructor(options: OtlpReceiverOptions) {
    if (options.forwardEndpoint !== null) {
      validateSsrfUrl('OtlpReceiver forwardEndpoint', new URL(options.forwardEndpoint));
      this.forwardDispatcher = new Agent({
        connect: { lookup: createSsrfSafeLookup('OtlpReceiver forward endpoint (resolved)') },
      });
    }
    this.options = Object.freeze(options);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handleRequest(req, res));
      // Use once() so the startup rejection handler is removed after start() resolves.
      // A permanent on('error') handler is registered below after listen() succeeds.
      this.server.once('error', reject);
      this.server.on('checkContinue', (req, res) => {
        res.writeContinue();
        void this.handleRequest(req, res);
      });
      const host = this.options.bindAddress ?? '127.0.0.1';
      this.server.listen(this.options.port, host, () => {
        logger.info('OTLP receiver listening', { port: this.options.port, host });
        // Permanent error handler for post-startup errors (e.g. EADDRINUSE on rebind).
        this.server!.on('error', (err) =>
          logger.error('OTLP receiver error', { error: String(err) }),
        );
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const timeoutMs = this.options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () => {
      res.writeHead(408);
      res.end();
      req.destroy(new RequestTimeoutError('Request timed out'));
    });

    const path = req.url ?? '';
    if (req.method !== 'POST' || !path.startsWith('/v1/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      this.checkAuthentication(req);
    } catch (err) {
      if (err instanceof AuthenticationError) {
        res.writeHead(401);
        res.end();
        return;
      }
      throw err;
    }

    try {
      this.checkRateLimit(req);
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        res.writeHead(429);
        res.end();
        return;
      }
      throw err;
    }

    try {
      this.checkContentType(req);
    } catch (err) {
      if (err instanceof UnsupportedContentTypeError) {
        res.writeHead(415);
        res.end();
        return;
      }
      throw err;
    }

    try {
      const body = await this.readBody(req);
      const enriched = this.enrichPayload(body);
      const contentType = req.headers['content-type'] ?? 'application/json';

      if (this.options.forwardEndpoint) {
        const result = await this.forward(enriched, path, contentType);
        res.writeHead(result.statusCode ?? 200, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    } catch (err) {
      // Timeout callback may have already sent 408 and destroyed the socket.
      // Guard every response write so we never call writeHead twice.
      if (res.headersSent) return;
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413);
        res.end();
        return;
      }
      if (err instanceof RequestTimeoutError) {
        // 408 already written by the setTimeout callback; just return.
        return;
      }
      if (err instanceof Error && err.message.startsWith('Unsupported Content-Encoding:')) {
        res.writeHead(415);
        res.end();
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes('Incomplete body') || err.message === 'Request aborted')
      ) {
        res.writeHead(400);
        res.end();
        return;
      }
      logger.error('OTLP receiver error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500);
      res.end();
    }
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const contentLengthHeader = req.headers['content-length'] as string | undefined;
    const parsedContentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
    const expectedBytes = Number.isFinite(parsedContentLength) ? parsedContentLength : null;

    return new Promise((resolve, reject) => {
      const contentEncoding =
        (req.headers['content-encoding'] as string | undefined)?.toLowerCase() ?? '';

      // Attach aborted listener early
      req.on('aborted', () => {
        reject(new Error('Request aborted'));
      });

      let stream: NodeJS.ReadableStream = req;
      let compressedBytes = 0;
      let isCompressed = false;

      if (contentEncoding === 'gzip') {
        isCompressed = true;
        // Track compressed bytes before piping
        req.on('data', (chunk: Buffer) => {
          compressedBytes += chunk.length;
        });
        stream = req.pipe(createGunzip());
      } else if (contentEncoding === 'deflate') {
        isCompressed = true;
        // Track compressed bytes before piping
        req.on('data', (chunk: Buffer) => {
          compressedBytes += chunk.length;
        });
        stream = req.pipe(createInflate());
      } else if (contentEncoding === 'br') {
        isCompressed = true;
        // Track compressed bytes before piping
        req.on('data', (chunk: Buffer) => {
          compressedBytes += chunk.length;
        });
        stream = req.pipe(createBrotliDecompress());
      } else if (contentEncoding && contentEncoding !== 'identity') {
        reject(new Error(`Unsupported Content-Encoding: ${contentEncoding}`));
        return;
      }

      const chunks: Buffer[] = [];
      let decompressedBytes = 0;
      stream.on('data', (chunk: Buffer) => {
        decompressedBytes += chunk.length;
        if (decompressedBytes > maxBytes) {
          // Reject without destroying the socket so the caller can still write the 413 response.
          reject(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        // Verify we received the expected number of bytes based on Content-Length
        if (expectedBytes !== null) {
          const receivedBytes = isCompressed ? compressedBytes : decompressedBytes;
          if (receivedBytes < expectedBytes) {
            reject(
              new Error(
                `Incomplete body: expected ${expectedBytes} bytes, received ${receivedBytes} bytes`,
              ),
            );
            return;
          }
        }
        resolve(Buffer.concat(chunks));
      });
      stream.on('error', reject);
    });
  }

  private checkAuthentication(req: IncomingMessage): void {
    if (!this.options.apiKey) {
      // No API key configured — authentication is optional
      return;
    }

    const authHeader = req.headers.authorization ?? '';
    const expectedAuth = `Bearer ${this.options.apiKey}`;

    const actual = Buffer.from(authHeader, 'utf8');
    const expected = Buffer.from(expectedAuth, 'utf8');

    // A prior version compared authHeader.length === expectedAuth.length as a
    // short-circuit before timingSafeEqual, leaking the correct credential's
    // length via response timing. A later version closed that by hashing
    // both sides first — but any digest of a credential-shaped value (hash
    // or HMAC) reads to static analysis as password-at-rest hashing, which
    // needs a slow KDF; that requirement doesn't apply here (nothing is
    // stored, so there's no offline brute-forcing surface), yet there's no
    // way to convey that distinction to the scanner. The actual fix is to
    // never compute a digest at all: run timingSafeEqual unconditionally
    // over two same-length buffers every time. lengthsMatch is a plain
    // integer comparison (O(1), not data-dependent) and decides only which
    // value gets copied — expected on the match path, actual on the
    // mismatch path — so BOTH paths always do exactly one Buffer.from() copy
    // plus one timingSafeEqual call, of a buffer sized to whatever length
    // the caller's own guess happened to be. There's no branch that skips
    // the copy on the match path, so cost as a function of the guess's
    // length has no discontinuity at the point where it happens to equal
    // the secret's length — which is what actually needs to not leak.
    const lengthsMatch = actual.length === expected.length;
    const comparisonTarget = lengthsMatch ? Buffer.from(expected) : Buffer.from(actual);
    const contentMatches = timingSafeEqual(actual, comparisonTarget);
    if (!lengthsMatch || !contentMatches) {
      throw new AuthenticationError('Invalid or missing authentication');
    }
  }

  private checkRateLimit(req: IncomingMessage): void {
    const rateLimitPerMinute = this.options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    const remoteAddr = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();

    // Get request history for this IP, if any.
    const timestamps = this.rateLimiter.get(remoteAddr) ?? [];

    // Prune timestamps older than the rate limit window.
    while (timestamps.length > 0 && timestamps[0]! < now - RATE_LIMIT_WINDOW_MS) {
      timestamps.shift();
    }

    // Check if rate limit exceeded. Every distinct source IP that ever makes
    // one request would otherwise leave a permanent (if empty) entry in
    // this.rateLimiter for the process lifetime — delete rather than
    // re-insert an empty array before throwing, so a rejected/aged-out IP
    // doesn't occupy a Map slot forever.
    if (timestamps.length >= rateLimitPerMinute) {
      if (timestamps.length === 0) {
        this.rateLimiter.delete(remoteAddr);
      } else {
        this.rateLimiter.set(remoteAddr, timestamps);
      }
      throw new RateLimitExceededError(
        `Rate limit exceeded: ${rateLimitPerMinute} requests per minute`,
      );
    }

    // Record this request and store the (now non-empty) array.
    timestamps.push(now);
    this.rateLimiter.set(remoteAddr, timestamps);
  }

  private checkContentType(req: IncomingMessage): void {
    const contentType =
      (req.headers['content-type'] as string | undefined)?.split(';')[0]?.trim() ??
      'application/json';

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new UnsupportedContentTypeError(`Unsupported Content-Type: ${contentType}`);
    }
  }

  enrichPayload(body: Buffer): Buffer {
    // For JSON-encoded OTLP (content-type: application/json), parse and inject attributes.
    // For protobuf-encoded OTLP (content-type: application/x-protobuf), pass through unchanged
    // (protobuf decoding requires additional dependencies — handle JSON only in v1).
    try {
      const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
      this.injectResourceAttributes(parsed, this.options.enrichmentAttributes);
      return Buffer.from(JSON.stringify(parsed));
    } catch {
      // Not JSON (likely protobuf) — forward as-is
      return body;
    }
  }

  private injectResourceAttributes(
    payload: Record<string, unknown>,
    attrs: Record<string, string>,
  ): void {
    // OTLP JSON structure: { resourceSpans: [{ resource: { attributes: [...] }, ... }] }
    // Also handle resourceMetrics and resourceLogs for /v1/metrics and /v1/logs
    for (const key of ['resourceSpans', 'resourceMetrics', 'resourceLogs']) {
      const resources = payload[key] as
        Array<{ resource?: { attributes?: unknown[] } }> | undefined;
      if (!Array.isArray(resources)) continue;

      for (const resource of resources) {
        if (!resource.resource) resource.resource = {};
        if (!Array.isArray(resource.resource.attributes)) resource.resource.attributes = [];
        const attributes = resource.resource.attributes as Array<{
          key: string;
          value?: unknown;
        }>;
        const existingKeys = new Set(attributes.map((a) => a.key));
        for (const [k, v] of Object.entries(attrs)) {
          // Never clobber a value the instrumented app deliberately set itself.
          if (existingKeys.has(k)) continue;
          attributes.push({ key: k, value: { stringValue: v } });
        }
      }
    }
  }

  private async forward(
    body: Buffer,
    path: string,
    contentType: string,
  ): Promise<{ statusCode: number; body: string }> {
    if (this.options.forwardEndpoint === null) {
      throw new Error('forward() called with no forwardEndpoint configured');
    }
    const url = `${this.options.forwardEndpoint}${path}`;
    // SECURITY: client request headers are deliberately NOT propagated to upstream — only forwardHeaders + Content-Type.
    // This prevents header injection attacks where a malicious client could inject headers into the upstream NR API call.
    // Do not change without security review.
    //
    // The dispatcher's connect.lookup (set in the constructor) is what actually
    // enforces SSRF protection here — resolving and validating the address this
    // fetch connects to, not just the hostname string. Do not add back a
    // validateSsrfUrl(...) call on the string here; re-checking the same
    // unvalidated string provides no real protection against DNS rebinding.
    const init: RequestInit & { dispatcher?: Agent } = {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...this.options.forwardHeaders,
      },
      body: body as unknown as BodyInit,
      dispatcher: this.forwardDispatcher,
    };
    const response = await globalThis.fetch(url, init);
    const responseBody = await response.text();
    return { statusCode: response.status, body: responseBody };
  }
}
