/**
 * HTTP Upstream — raw HTTP proxy for upstream MCP servers that speak HTTP.
 *
 * Guarantees bit-for-bit passthrough: the proxy reads the request body into a
 * Buffer (to peek at the JSON-RPC method for observability) then forwards the
 * raw bytes unchanged via http.request(). SSE responses are piped chunk-by-chunk.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, type TransformCallback } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { createLogger } from '@nr-ai-observatory/shared';
import type { ForwardResult, ProxyUpstream, UpstreamConfig } from './types.js';
import { shouldForwardHeader } from './types.js';

const logger = createLogger('proxy-http');

// Hop-by-hop headers that must never be forwarded between proxy and client.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailers',
  'proxy-authorization',
  'proxy-authenticate',
]);

// ---------------------------------------------------------------------------
// ByteCountTransform — counts bytes flowing through without modification
// ---------------------------------------------------------------------------

export class ByteCountTransform extends Transform {
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// Matches loopback, RFC-1918 private ranges, and link-local (169.254/16).
// Covers both bare IPv6 (::1) and bracket-wrapped ([::1]) forms since
// Node.js URL.hostname returns the bracketed form for IPv6 addresses.
const BLOCKED_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?::1\]?$|0\.0\.0\.0$|localhost$)/i;

function validateUpstreamUrl(name: string, url: URL): void {
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `HttpUpstream "${name}": scheme "${url.protocol}" is not allowed; use http: or https:`,
    );
  }
  if (BLOCKED_HOST_RE.test(url.hostname)) {
    throw new Error(
      `HttpUpstream "${name}": host "${url.hostname}" resolves to a private or loopback address`,
    );
  }
}

// ---------------------------------------------------------------------------
// HttpUpstream
// ---------------------------------------------------------------------------

export class HttpUpstream implements ProxyUpstream {
  readonly name: string;
  readonly transportType = 'http' as const;
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(config: UpstreamConfig) {
    if (!config.url) {
      throw new Error(`HttpUpstream "${config.name}" requires a url`);
    }
    this.name = config.name;
    this.url = new URL(config.url);
    if (!config.allowPrivateHosts) {
      validateUpstreamUrl(this.name, this.url);
    }
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    logger.debug(`HTTP upstream "${this.name}" connected`, { url: this.url.href });
  }

  async disconnect(): Promise<void> {
    logger.debug(`HTTP upstream "${this.name}" disconnected`);
  }

  async forward(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<ForwardResult> {
    const requestFn = this.url.protocol === 'https:' ? httpsRequest : httpRequest;

    // Build forwarded headers
    const headers: Record<string, string> = {};
    if (req.headers) {
      for (const [key, value] of Object.entries(req.headers)) {
        if (value != null && shouldForwardHeader(key)) {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }
    }
    if (body.length > 0) {
      headers['content-length'] = String(body.length);
    }

    return new Promise<ForwardResult>((resolve, _reject) => {
      const start = performance.now();

      const upstreamReq = requestFn(
        this.url,
        {
          method: req.method ?? 'POST',
          headers,
          timeout: this.timeoutMs,
        },
        (upstreamRes) => {
          const upstreamLatencyMs = performance.now() - start;
          const statusCode = upstreamRes.statusCode ?? 502;

          const mediaType = (upstreamRes.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          const isStreaming = mediaType === 'text/event-stream';

          // Copy response headers, skipping hop-by-hop headers
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value != null && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
              res.setHeader(key, value);
            }
          }

          if (isStreaming) {
            res.writeHead(statusCode);
            // SSE: pipe chunk-by-chunk through ByteCountTransform
            const counter = new ByteCountTransform();
            let sseResolved = false;

            const resolveSSE = () => {
              if (sseResolved) return;
              sseResolved = true;
              resolve({
                statusCode,
                isStreaming: true,
                responseSizeBytes: counter.bytes,
                upstreamLatencyMs,
              });
            };

            counter.on('error', (err) => {
              logger.error('Stream error in ByteCountTransform', { error: String(err) });
              if (!res.writableEnded) {
                res.socket?.destroy();
              }
              resolveSSE();
            });

            upstreamRes
              .pipe(counter)
              .pipe(res);

            upstreamRes.on('end', resolveSSE);

            upstreamRes.on('error', (err) => {
              logger.error('Upstream SSE stream error', { error: String(err) });
              resolveSSE();
            });

            res.on('close', () => {
              if (!upstreamRes.destroyed) {
                upstreamRes.destroy();
              }
              resolveSSE();
            });
          } else {
            // Non-SSE: buffer full body, then write with recomputed content-length
            const chunks: Buffer[] = [];
            upstreamRes.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
            });
            upstreamRes.on('end', () => {
              const responseBody = Buffer.concat(chunks);
              res.setHeader('content-length', responseBody.length);
              res.writeHead(statusCode);
              res.end(responseBody);
              resolve({
                statusCode,
                isStreaming: false,
                responseSizeBytes: responseBody.length,
                upstreamLatencyMs,
              });
            });
            upstreamRes.on('error', (err) => {
              logger.error('Upstream response error', { error: String(err) });
              const bytesAlreadySent = chunks.reduce((sum, c) => sum + c.length, 0);
              if (bytesAlreadySent > 0 && !res.writableEnded) {
                res.socket?.destroy();
              } else if (!res.writableEnded) {
                res.writeHead(statusCode, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'upstream_error', message: String(err) }));
              }
              resolve({
                statusCode,
                isStreaming: false,
                responseSizeBytes: bytesAlreadySent,
                upstreamLatencyMs,
              });
            });
          }
        },
      );

      upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error(`Upstream "${this.name}" timed out after ${this.timeoutMs}ms`));
      });

      upstreamReq.on('error', (err) => {
        const upstreamLatencyMs = performance.now() - start;
        logger.error('Upstream request error', { error: String(err), upstream: this.name });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: 'upstream_unavailable', message: String(err) }));
        }
        resolve({
          statusCode: 502,
          isStreaming: false,
          responseSizeBytes: 0,
          upstreamLatencyMs,
        });
      });

      // Send the raw body unchanged
      if (body.length > 0) {
        upstreamReq.end(body);
      } else {
        upstreamReq.end();
      }
    });
  }
}
