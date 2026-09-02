#!/usr/bin/env tsx
// Regenerates src/proxy/otlp-descriptor.ts from a pinned commit of
// open-telemetry/opentelemetry-proto. Automates the fetch -> pbjs -> strip ->
// write recipe that file's header used to document as a manual procedure:
// fetch that commit's proto tree, run `pbjs -t json` over the three OTLP/HTTP
// service protos, delete the resulting *Service entries (gRPC stubs this HTTP
// transcoder never uses, and whose method descriptors don't type-check
// against protobufjs's INamespace), and write the result back out as a .ts
// module.
//
// Usage: npx tsx scripts/regenerate-otlp-descriptor.ts [commit-sha]
//   commit-sha defaults to the commit currently pinned below. Pass a newer
//   commit from open-telemetry/opentelemetry-proto to pick up schema changes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DESCRIPTOR_PATH = join(process.cwd(), 'src/proxy/otlp-descriptor.ts');
const DEFAULT_COMMIT = 'dfd0b0e';

// Signal name -> proto file (relative to the extracted repo root) and the
// gRPC *Service entry pbjs emits for it, which gets deleted below.
const SIGNALS = [
  {
    name: 'logs',
    proto: 'opentelemetry/proto/collector/logs/v1/logs_service.proto',
    service: 'LogsService',
  },
  {
    name: 'metrics',
    proto: 'opentelemetry/proto/collector/metrics/v1/metrics_service.proto',
    service: 'MetricsService',
  },
  {
    name: 'trace',
    proto: 'opentelemetry/proto/collector/trace/v1/trace_service.proto',
    service: 'TraceService',
  },
] as const;

function fetchProtoTree(commit: string, destDir: string): void {
  const tarUrl = `https://codeload.github.com/open-telemetry/opentelemetry-proto/tar.gz/${commit}`;
  const tarPath = join(destDir, 'proto.tar.gz');
  execFileSync('curl', ['-fsSL', '-o', tarPath, tarUrl]);
  execFileSync('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1']);
}

function runPbjs(protoRoot: string): Record<string, unknown> {
  const output = execFileSync(
    'npx',
    ['-y', '-p', 'protobufjs-cli', 'pbjs', '-t', 'json', '-p', '.', ...SIGNALS.map((s) => s.proto)],
    { cwd: protoRoot, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(output) as Record<string, unknown>;
}

// Descends nested.opentelemetry.nested.proto.nested.collector.nested[signal].nested.v1.nested
// and deletes the *Service entry pbjs put there.
function stripServiceStubs(descriptor: Record<string, unknown>): void {
  const collectorNs = descend(descriptor, [
    'nested',
    'opentelemetry',
    'nested',
    'proto',
    'nested',
    'collector',
    'nested',
  ]);
  for (const { name, service } of SIGNALS) {
    const v1Ns = descend(collectorNs, [name, 'nested', 'v1', 'nested']);
    if (!(service in v1Ns)) {
      throw new Error(
        `Expected to find ${service} under collector.${name}.v1 — pbjs output shape changed?`,
      );
    }
    delete v1Ns[service];
  }
}

function descend(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node = root;
  for (const key of path) {
    const next = node[key];
    if (typeof next !== 'object' || next === null) {
      throw new Error(
        `Expected object at '${path.join('.')}' (missing '${key}') — pbjs output shape changed?`,
      );
    }
    node = next as Record<string, unknown>;
  }
  return node;
}

function writeDescriptorFile(descriptor: Record<string, unknown>, commit: string): void {
  const header = `// pbjs JSON descriptor for the three OTLP/HTTP export request types.
//
// Generated from open-telemetry/opentelemetry-proto @ ${commit} by:
//   npx tsx scripts/regenerate-otlp-descriptor.ts ${commit}
// which fetches that commit's proto tree, runs \`pbjs -t json\` over the three
// OTLP/HTTP service protos, and deletes the resulting *Service entries: they
// are gRPC service stubs this HTTP transcoder never uses, and their method
// descriptors do not type-check against protobufjs's INamespace (IMethod
// declares \`comment\` as required, but pbjs never emits one).
//
// To pick up a newer OTLP schema, re-run that command with a newer commit SHA
// from open-telemetry/opentelemetry-proto and replace the object below.
// Vendored as a .ts module (not .json) so the compiled dist ships it without
// resolveJsonModule or copy steps.
export const OTLP_DESCRIPTOR = ${JSON.stringify(descriptor, null, 2)};
`;
  writeFileSync(DESCRIPTOR_PATH, header);
  execFileSync('npx', ['prettier', '--write', DESCRIPTOR_PATH], { stdio: 'inherit' });
}

function main(): void {
  const commit = process.argv[2] ?? DEFAULT_COMMIT;
  const tmpDir = mkdtempSync(join(tmpdir(), 'otlp-proto-'));
  try {
    mkdirSync(tmpDir, { recursive: true });
    console.log(`Fetching open-telemetry/opentelemetry-proto @ ${commit}...`);
    fetchProtoTree(commit, tmpDir);
    console.log('Running pbjs...');
    const descriptor = runPbjs(tmpDir);
    stripServiceStubs(descriptor);
    writeDescriptorFile(descriptor, commit);
    console.log(`Wrote ${DESCRIPTOR_PATH}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
