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

Push to `main` with GitHub Pages set to "GitHub Actions" as its source
(Settings → Pages) and the included workflow builds and deploys
automatically — no backend required for that to produce a working, live
copy.

## License

Personal project, not yet licensed for redistribution.
