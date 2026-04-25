import http from 'http';
import https from 'https';

const PORT = parseInt(process.env['PORT'] || '4000', 10);
const KEEPALIVE_MS = parseInt(process.env['KEEPALIVE_MS'] || '30000', 10);

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': '*',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

function extractTarget(requestUrl: string): URL | null {
  try {
    const idx = requestUrl.indexOf('?target=');
    if (idx === -1) return null;
    const target = decodeURIComponent(requestUrl.slice(idx + 8));
    if (!target) return null;
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify({ error: message }));
}

function handleProxy(req: http.IncomingMessage, res: http.ServerResponse, targetUrl: URL): void {
  let clientDisconnected = false;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let proxyReq: http.ClientRequest | null = null;

  const clearKeepAlive = (): void => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  res.on('close', () => {
    clientDisconnected = true;
    clearKeepAlive();
    proxyReq?.destroy();
  });

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    const forwardHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
    forwardHeaders['host'] = targetUrl.host;
    forwardHeaders['content-length'] = String(body.length);
    delete forwardHeaders['connection'];
    delete forwardHeaders['transfer-encoding'];

    const isHttps = targetUrl.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;

    // Cloudflare 터널 100초 타임아웃 방지:
    // upstream 응답 대기 중 30초마다 공백 바이트 전송
    keepAliveTimer = setInterval(() => {
      if (clientDisconnected || res.writableEnded) {
        clearKeepAlive();
        return;
      }
      if (!res.headersSent) {
        res.writeHead(200, CORS);
      }
      res.write(' ');
    }, KEEPALIVE_MS);

    proxyReq = requestFn(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: forwardHeaders,
      },
      (proxyRes) => {
        clearKeepAlive();
        if (clientDisconnected) return;

        if (!res.headersSent) {
          const responseHeaders: Record<string, string | string[] | undefined> = {
            ...proxyRes.headers,
            ...CORS,
          };
          res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        }

        proxyRes.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', () => {
      clearKeepAlive();
      sendError(res, 502, 'upstream unreachable');
    });

    proxyReq.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = req.url || '/';

  if (url === '/_health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const targetUrl = extractTarget(url);
  if (!targetUrl) {
    sendError(res, 400, 'missing or invalid target parameter');
    return;
  }

  handleProxy(req, res, targetUrl);
});

server.listen(PORT, () => {
  console.log(`proxy listening on :${PORT}`);
});
