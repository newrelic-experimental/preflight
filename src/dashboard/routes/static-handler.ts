import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveIndexFallback(root: string, res: ServerResponse): Promise<void> {
  try {
    const indexPath = join(root, 'index.html');
    const data = await readFile(indexPath);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(data.length),
      // index.html must always be revalidated so a fresh build is picked
      // up immediately. The hashed assets it references can be cached
      // aggressively.
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

export function createStaticHandler(
  rootDir: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(rootDir);
  return async (req, res) => {
    const url = req.url ?? '/';
    const reqPath = url.split('?')[0] ?? '/';
    const filename = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');

    // Reject null bytes and explicit traversal components before path resolution.
    // resolve() would eliminate these too, but the explicit check here makes the
    // sanitization visible to static analysis (CodeQL js/path-injection).
    if (filename.includes('\0') || filename.split('/').some((c) => c === '..')) {
      res.writeHead(403);
      res.end();
      return;
    }

    const target = resolve(join(root, filename));
    // Use a literal '/' so static analysis tools (CodeQL js/path-injection)
    // can recognise this as the standard path-containment sanitizer pattern.
    // The runtime sep from node:path would be equivalent on POSIX, but CodeQL
    // cannot statically prove that sep === '/' and therefore misses the guard.
    if (!target.startsWith(root + '/')) {
      res.writeHead(403);
      res.end();
      return;
    }
    const ext = extname(target).toLowerCase();
    const hasFileExtension = ext.length > 0;

    // Only serve files whose extension appears in the explicit MIME allow-list.
    // This limits what readFile() can reach to known web-asset types even if a
    // future change inadvertently widens the path-containment check above.
    if (hasFileExtension && !(ext in MIME)) {
      res.writeHead(403);
      res.end();
      return;
    }

    try {
      const st = await stat(target);
      if (!st.isFile()) {
        // F-033: An on-disk path that exists but is not a regular file
        // (typically a directory like /assets/) is not a valid SPA route —
        // returning index.html here masks misconfigured asset paths in
        // dev. The SPA fallback is reserved for genuinely missing paths
        // (the ENOENT path below).
        res.writeHead(404);
        res.end();
        return;
      }
      const type = MIME[ext] ?? 'application/octet-stream';
      const data = await readFile(target);
      // F-034: Vite-built assets live under /assets/ with content-hash
      // filenames (main-abc123.js), so they can be cached forever. The
      // shell index.html must revalidate every time so a fresh build's
      // new asset hashes are picked up. Other static files (the rare
      // unhashed asset, robots.txt, favicons that aren't in /assets/)
      // get a short cache for sane DevTools behaviour.
      // Check against path relative to root, not the full absolute path, to
      // avoid false positives when rootDir itself contains an 'assets' component.
      const relPath = target.slice(root.length);
      const isAsset = relPath.includes(`${sep}assets${sep}`);
      const isIndexHtml = filename === 'index.html';
      const cacheControl = isIndexHtml
        ? 'no-cache'
        : isAsset
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300';
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(data.length),
        'cache-control': cacheControl,
      });
      res.end(data);
    } catch {
      if (hasFileExtension) {
        res.writeHead(404);
        res.end();
        return;
      }
      return await serveIndexFallback(root, res);
    }
  };
}
