// Eskimo Studio — audio upload worker
//
// A small Cloudflare Worker that sits between the browser and your R2
// bucket. The browser POSTs a raw file to /upload; this worker writes it
// into R2 through its bucket binding (see wrangler.toml) and returns the
// public URL. R2 credentials never exist on the client — the binding is
// the only thing with write access, and it only exists inside this worker.
//
// Deploy with: `npx wrangler deploy` from this directory (see TODO.md ->
// "Your tasks" for the account-level setup this needs first). Then put the
// worker's URL into APP_CONFIG.UPLOAD_WORKER_URL at the top of index.html.

const ALLOWED_ORIGIN = '*'; // tighten to your Pages URL once you have one

function withCors(res) {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
      const filename = url.searchParams.get('filename') || 'upload.bin';
      // one object per upload — a random prefix keeps names from colliding
      // without leaking anything about the uploader
      const key = crypto.randomUUID() + '-' + filename.replace(/[^\w.\-]+/g, '_');

      await env.AUDIO_BUCKET.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
      });

      // requires the bucket's public access (r2.dev subdomain, or your own
      // custom domain) to be turned on — see TODO.md
      const publicUrl = env.PUBLIC_BUCKET_URL.replace(/\/$/, '') + '/' + key;
      return withCors(Response.json({ url: publicUrl, key }));
    }

    return withCors(new Response('Not found', { status: 404 }));
  },
};
