import protobuf from 'protobufjs';

import { OTLP_DESCRIPTOR } from './otlp-descriptor.js';

// Signal paths per the OTLP/HTTP spec.
const REQUEST_TYPES_BY_PATH: Record<string, string> = {
  '/v1/traces': 'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
  '/v1/metrics': 'opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest',
  '/v1/logs': 'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest',
};

// toObject/fromObject must round-trip losslessly: 64-bit nanosecond timestamps
// exceed Number.MAX_SAFE_INTEGER (so longs become decimal strings, which
// fromObject parses back exactly), and traceId/spanId byte fields stay Buffers
// rather than being transcoded through base64.
const TO_OBJECT_OPTIONS = { longs: String, bytes: Buffer } as const;

let cachedRoot: protobuf.Root | undefined;

function lookupRequestType(path: string): protobuf.Type | null {
  const typeName = REQUEST_TYPES_BY_PATH[path];
  if (!typeName) return null;
  cachedRoot ??= protobuf.Root.fromJSON(OTLP_DESCRIPTOR);
  return cachedRoot.lookupType(typeName);
}

/**
 * Decodes a protobuf OTLP export request into the same plain-object shape the
 * JSON path works with (camelCase keys, attribute values as `{ stringValue }`).
 * Returns null when the path is not a known OTLP signal; throws when the bytes
 * are not a valid message.
 */
export function decodeOtlpRequest(path: string, body: Buffer): Record<string, unknown> | null {
  const type = lookupRequestType(path);
  if (!type) return null;
  return type.toObject(type.decode(body), TO_OBJECT_OPTIONS);
}

/** Re-encodes a payload produced by decodeOtlpRequest, after enrichment. */
export function encodeOtlpRequest(path: string, payload: Record<string, unknown>): Buffer {
  const type = lookupRequestType(path);
  if (!type) throw new Error(`No OTLP request type for path: ${path}`);
  return Buffer.from(type.encode(type.fromObject(payload)).finish());
}
