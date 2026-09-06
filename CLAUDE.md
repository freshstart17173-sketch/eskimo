# Working on Eskimo Studio — read this first

**Push to `main`.** This repo deploys to Vercel
(https://eskimo-freshstart17173-9037s-projects.vercel.app/) straight from
the `main` branch — that's the live site the user actually looks at. A
change sitting on a `claude/*` feature branch, unmerged, is invisible to
them. Unless the user explicitly asks for a feature branch or a PR instead,
commit and push directly to `main`.

(`.github/workflows/pages.yml` also deploys `main` to GitHub Pages — a
second, separate target. Harmless to leave running; Vercel is the one that
matters here.)

See `TODO.md` for the actual project handoff notes — architecture, what's
done, what's in progress, known issues.
