import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// On this host, a single loopback TCP segment in a band of sizes is never
// acknowledged, so the browser sits on the loader. Dev responses in that band
// are padded with a comment to a size that is delivered.
function loopbackSafeBody(
  chunk: unknown,
  encoding: BufferEncoding | undefined,
  contentType: unknown,
): Buffer | null {
  if (chunk == null || chunk === '') return null;
  const type = String(contentType || '');
  if (!/javascript|ecmascript|css|html/.test(type)) return null;
  const body = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), encoding ?? 'utf8');
  if (body.length < 7500 || body.length >= 65528) return null;
  const open = type.includes('css') ? '/*' : type.includes('html') ? '<!--' : '\n/*';
  const close = type.includes('css') ? '*/' : type.includes('html') ? '-->' : '*/';
  const spaces = 65536 - body.length - open.length - close.length;
  if (spaces < 0) return null;
  const comment = Buffer.from(open + ' '.repeat(spaces) + close);
  const marker = Buffer.from(type.includes('css') ? '\n/*# sourceMappingURL=' : '\n//# sourceMappingURL=');
  const at = body.lastIndexOf(marker);
  if (at < 0) return Buffer.concat([body, comment]);
  return Buffer.concat([body.subarray(0, at), comment, body.subarray(at)]);
}

function loopbackDelivery(): Plugin {
  return {
    name: 'loopback-delivery',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        const end = res.end;
        res.end = function (chunk?: unknown, encoding?: unknown, cb?: unknown) {
          let done = cb;
          let enc = encoding as BufferEncoding | undefined;
          if (typeof chunk === 'function') {
            return end.call(this, chunk);
          }
          if (typeof encoding === 'function') {
            done = encoding;
            enc = undefined;
          }
          const padded = loopbackSafeBody(chunk, enc, this.getHeader('Content-Type'));
          if (!padded) {
            return end.call(this, chunk as never, enc as never, done as never);
          }
          if (this.getHeader('Content-Length')) {
            this.setHeader('Content-Length', padded.length);
          }
          return end.call(this, padded, done as never);
        } as typeof res.end;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), loopbackDelivery()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
