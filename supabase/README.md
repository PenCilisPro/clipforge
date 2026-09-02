# Supabase setup

1. Create a project at https://supabase.com (region close to your users).
2. Open **SQL Editor** and paste the contents of `migrations/0001_init.sql`, then run it.
   This creates all tables (`profiles`, `projects`, `clips`, `jobs`, `scheduled_posts`,
   `social_connections`), the `handle_new_user` trigger, RLS policies, the storage
   buckets (`source-videos`, `clips`, `assets`), and enables Realtime.
3. **Authentication → Providers**:
   - *Email*: enable (allow new user signups for the free plan).
   - *Google*: enable and paste your Google OAuth Client ID/Secret from
     https://console.cloud.google.com/apis/credentials. The authorized redirect URI
     Google expects is `https://<project-ref>.supabase.co/auth/v1/callback`.
4. **Authentication → URL Configuration**: set *Site URL* to your frontend URL
   (e.g. `http://localhost:3000`) and add `http://localhost:3000/auth/callback`
   (plus your production URL) to *Redirect URLs*.
5. Copy from **Project Settings → API** into your env files:
   - `SUPABASE_URL` → `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` (backend + worker ONLY — never the frontend)

## Google Cloud (Speech-to-Text) prerequisites

- Create a GCP project, enable the *Cloud Speech-to-Text API*.
- Create a service account with the "Cloud Speech-to-Text User" role and download
  its JSON key. On Railway, either set `GOOGLE_APPLICATION_CREDENTIALS` to the path
  of a mounted key file or paste the whole JSON into `GOOGLE_CREDENTIALS_JSON`
  (the worker supports both).
