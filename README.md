# Eskimo Studio

A graph-based set-planning tool for DJs/producers who build their own
transitions, intros, and outros in a DAW. Songs are nodes; the produced
audio that connects them are edges. Perform mode turns that graph into a
live routing surface — plan visually, then cue what's next.

This is not live-performance DJ software (no beatmatching/decks) — it's
where studio-built transitions live so a set can adapt in the moment
without losing the work already put into them. See `TODO.md` for the full
positioning note, the backlog, and the reasoning behind past decisions.

## Quick start

```sh
npm install
npm run dev       # local dev server
npm run build     # production build -> dist/
npm run preview   # serve the production build locally
```

Nothing needs to be configured to use the app locally — it works fully
offline against this browser's storage. Cloud sync and audio uploads turn
on automatically once the values in `src/config.js` are filled in (see
`TODO.md` → "Your tasks" for exactly how to get each one).

## Project layout

```
src/
  core.js          data model, persistence (local + Supabase), pure logic
  audioDetect.js   real audio matching for Add Audio (Web Audio API + correlation)
  graphLayout.js   dagre auto-arrange for the graph canvas
  config.js        the three optional backend values
  App.jsx          top-level shell (sidebar + page routing)
  components/      one file per page/section
supabase/
  schema.sql       the `library` table + RLS policies
worker/
  upload-worker.js Cloudflare Worker: browser -> R2, no credentials client-side
  wrangler.toml    worker config (bucket binding, public URL)
.github/workflows/pages.yml   builds + deploys dist/ to GitHub Pages
```

## Deploying

**To get a live URL at all (works standalone, no backend):**
1. Push this repo to GitHub.
2. Repo Settings → Pages → Source: "GitHub Actions".
3. Push to `main` — the included workflow builds and deploys automatically.

That's it for a working copy — local-storage only, same as running it on
your own machine. Everything below is optional, and each piece turns on
independently the moment its values are filled in.

**To turn on cross-device sync (Supabase):**
1. `src/config.js` already has a real Supabase project's URL + anon key
   wired in — nothing to do here unless you want your own project.
2. In that Supabase project: Authentication → Providers → enable
   **Anonymous Sign-Ins**. Sync silently does nothing until this is on.
3. Confirm `supabase/schema.sql` has been run against it (SQL Editor → run
   the file) — this creates the one table sync writes to.

**To turn on audio uploads + real detection (Cloudflare R2):**
1. `npx wrangler login`
2. `npx wrangler r2 bucket create eskimo-studio-audio`
3. Cloudflare dashboard → that bucket → Settings → Public access → turn on
   → copy the public URL into `worker/wrangler.toml`'s `PUBLIC_BUCKET_URL`.
4. Same bucket → Settings → CORS Policy → add:
   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
   (this is what lets the browser fetch reference audio for detection and
   downloads — separate from the worker's own CORS handling below)
5. `cd worker && npx wrangler deploy` → copy the `*.workers.dev` URL it
   prints out.
6. Paste that URL into `src/config.js`'s `UPLOAD_WORKER_URL` (or add it as
   a `UPLOAD_WORKER_URL` repository secret instead, alongside
   `SUPABASE_URL`/`SUPABASE_ANON_KEY` if you're overriding those too — see
   `.github/workflows/pages.yml`).
7. Push. Upload a song's master on Upload Song, and Add Audio's detection
   switches from placeholder matching to real analysis automatically.

## License

Personal project, not yet licensed for redistribution.
