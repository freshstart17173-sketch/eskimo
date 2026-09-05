import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path matches how GitHub Pages serves a repo that isn't a user/org
// root site (https://<user>.github.io/<repo>/) — see .github/workflows/pages.yml.
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES ? './' : '/',
});
