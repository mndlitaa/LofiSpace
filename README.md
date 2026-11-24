# LofiSpace

LofiSpace is a Pomodoro PWA with tasks, a focus journal, a personal soundtrack library, profile editing, and account authentication. Supabase Auth handles signup and login; the Express API scopes app data to the signed-in account.

## Prerequisites

- Node.js 20 or newer
- A Supabase project
- Postman (optional, for trying the API)

## 1. Prepare Supabase

### Existing LofiSpace database

1. Open **Supabase Dashboard → SQL Editor**.
2. Open `database/auth-migration.sql`, paste its full contents, and click **Run**. This adds an Auth user link and profile frame without changing existing task, journal, soundtrack, or focus-session records. The first account created in the app claims the existing demo user row (`id=1`), preserving its data.

### New database

Paste and run `database/schema.sql` in the SQL Editor. It creates the tables and Auth columns together.

3. In Supabase **Authentication → Providers**, make sure **Email** is enabled. If email confirmation is enabled, new users must confirm the message sent to their inbox before logging in.
4. Open **Project Settings → API Keys** and copy the project URL plus the server-side secret key. The service role key can be used for older projects.

Never put the Supabase secret/service-role key in frontend files or Postman. The Express backend reads it from `server/.env`.

## 2. Configure the backend

Copy `server/.env.example` to `server/.env` and fill in the values from Supabase:

```env
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
SUPABASE_URL=https://project-ref.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your_server_secret
```

Keep the secret key only in `server/.env`. Do not add it to `client/.env`.

## 3. Start and create your account

From the project root, run:

```sh
npm install
npm run dev
```

Open `http://localhost:5173`, choose **Create account**, and enter a display name, email, and password (at least 8 characters). Confirm your email first if Supabase asks for it, then sign in.

Tasks, journals, profile, focus sessions, and uploaded soundtrack records are saved under the signed-in account. Logging out ends the session; it does not delete the account or its data. The browser keeps a per-account local cache as well.

Check `http://localhost:3001/api/health` to confirm the API can reach Supabase. Other `/api` routes require a login token.

## 4. Use the API in Postman (optional)

Import `postman/LofiSpace.postman_collection.json`. Send **Auth → Sign in** once; its test script stores the access token in the collection's `accessToken` variable. Other requests inherit that bearer token. The collection also contains signup and logout requests. Health is public.

The collection covers tasks, journals, soundtracks, profile, focus sessions, and health. The MP3 upload endpoint accepts files up to 25 MB.

## Build the PWA

Run `npm run build` from the project root. Vite PWA generates the installable web app shell; soundtrack audio still needs an internet connection.
