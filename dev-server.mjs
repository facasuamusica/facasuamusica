// Preview local sem workerd: `wrangler dev` aborta nesta máquina porque o
// runtime nativo exige um Visual C++ Redistributable mais novo do que o
// instalado, e atualizá-lo pede admin. Como o Worker apenas repassa os assets
// de public/, servir esse diretório reproduz o comportamento de produção.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2'
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));

  if (relative.startsWith('..') || relative.includes(`..${sep}`)) {
    res.writeHead(403).end('403');
    return;
  }

  // Como no Cloudflare, um caminho sem extensao (/site) cai no index.html do
  // diretorio correspondente.
  const candidates = extname(relative)
    ? [relative]
    : [join(relative, 'index.html'), `${relative}.html`];

  for (const candidate of candidates) {
    const file = join(ROOT, candidate);
    let body;

    try {
      body = await readFile(file);
    } catch {
      continue;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`404 - ${path}`);
}).listen(PORT, () => {
  console.log(`Servindo public/ em http://localhost:${PORT}`);
});
