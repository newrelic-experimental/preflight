import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.map':  'application/json; charset=utf-8',
};

async function serveIndexFallback(root: string, res: ServerResponse): Promise<void> {
  try {
    const indexPath = join(root, 'index.html');
    const data = await readFile(indexPath);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(data.length),
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

export function createStaticHandler(rootDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(rootDir);
  return async (req, res) => {
    const url = req.url ?? '/';
    const reqPath = url.split('?')[0] ?? '/';
    const filename = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const target = resolve(join(root, filename));
    if (!target.startsWith(root + sep) && target !== root) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const st = await stat(target);
      if (!st.isFile()) {
        return await serveIndexFallback(root, res);
      }
      const ext = extname(target).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';
      const data = await readFile(target);
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(data.length),
      });
      res.end(data);
    } catch {
      // Asset requests (paths with a file extension) should 404, not fall back —
      // otherwise a request for /missing.js gets the SPA HTML and the browser tries
      // to execute it as JavaScript. Only extensionless paths are SPA routes.
      if (extname(target)) {
        res.writeHead(404);
        res.end();
        return;
      }
      return await serveIndexFallback(root, res);
    }
  };
}
