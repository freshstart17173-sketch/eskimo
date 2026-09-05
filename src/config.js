// Eskimo Studio config. Real values fill in as each backend piece comes
// online — see TODO.md -> "Your tasks" for exactly how each one is
// obtained. Everything works with these blank (local-storage only, no
// network calls) so there's nothing you have to configure to just use it.
//
// SUPABASE_URL / SUPABASE_ANON_KEY are already filled in against a live
// "eskimo" Supabase project (schema applied, anon key — never a
// service_role key, safe to ship in a static site because Row Level
// Security is what actually protects the data). Anonymous sign-ins still
// need to be turned on for this project in the dashboard before sync
// actually authenticates — see TODO.md.
export const APP_CONFIG = {
  SUPABASE_URL: 'https://knkboafsybgifsulxknz.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_xgQzIM36N_ym9j-MjvfLXw_x13jaXB-',
  UPLOAD_WORKER_URL: '', // fill in once worker/upload-worker.js is deployed
};
