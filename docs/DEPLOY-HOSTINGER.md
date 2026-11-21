# Deploying HotelPOS on Hostinger

HotelPOS runs on Hostinger's **Node.js web hosting** (Business or Cloud plan). Hostinger runs the app and the database on the same server:

```
 Browser / POS tablet ──HTTPS──▶ Hostinger (TLS, proxy) ──▶ Node 22: hostinger.cjs → index.js ──▶ MariaDB 11.8 (127.0.0.1:3306)
```

Live demo: **https://hotelpos.ecomap.site** (database `u636932635_hotelpos`).

Hostinger's database is **MariaDB**, not MySQL 8.4 as in Laragon. The migrations and queries work on both engines.

## 1. Create the site and the database (hPanel)

1. **Websites → Add website → Node.js Apps → Upload your website files**, then pick the domain. A site added as a plain PHP/HTML website cannot run Node.js. If that happened, delete it and add it again as a Node.js app.
2. **Databases → Management:** create a database and user (Hostinger adds the `u636932635_` prefix to both) with a long random password.

## 2. Environment variables

Under the app's **Environment variables**, set (no `.env` file on the server):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `COOKIE_SECURE` | `true` (Hostinger serves HTTPS) |
| `TRUST_PROXY` | `1` (Hostinger's proxy; needed for secure cookies and real client IPs) |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` (not the `srvNNNN.hstgr.io` host) |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | from step 1, with the `u636932635_` prefix |
| `PAYMENT_RETURN_URL` | `https://<domain>/pay/complete` |

Saving them restarts the app.

## 3. Create the schema (from your computer)

Hostinger has no terminal for running `npm run migrate`, so run it from your computer against the remote database:

1. **Databases → Remote MySQL:** allow your public IP for the database.
2. In PowerShell from the project folder (the shell variables override `.env`):

   ```powershell
   $env:NODE_ENV="production"; $env:SESSION_SECRET="x"
   $env:DB_HOST="srv2101.hstgr.io"; $env:DB_NAME="u636932635_hotelpos"
   $env:DB_USER="u636932635_hotelpos"; $env:DB_PASSWORD="<password>"
   npm run migrate -- --seed --demo
   ```

   The generated passwords are printed once and appended to `storage/seed-credentials.txt`.
3. Remove the Remote MySQL rule again when you are done.

## 4. Upload the app

```powershell
node deploy/package-hostinger.js
```

This copies the last commit into `dist/hostinger/`, without the tests, Electron and the `.docx` file. Its `package.json` has no Electron dev dependencies, and its `build` only checks syntax, because Hostinger always runs `npm install` and `npm run build`. Zip the **contents** of `dist/hostinger` (not the folder itself) and upload the zip in hPanel with these build settings:

| Setting | Value |
|---|---|
| Framework | Express |
| Node version | 22 |
| Entry file | `hostinger.cjs` |
| Build command | `npm run build` |
| Output directory | empty |

`hostinger.cjs` exists because Hostinger loads the entry file with `require()`, and `index.js` is an ES module.

Check that the app is up: `https://<domain>/api/v1/health` should return `"database":"up"`.

## 5. Updating

1. Commit your changes.
2. Run `npm run migrate` against the remote database (step 3) if you added migrations.
3. Run `node deploy/package-hostinger.js` and upload the new zip.

Never use `--fresh` on this database.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Upload or deploy returns 404 | The site was created as a PHP/HTML website; add it again as a Node.js app (step 1) |
| `Access denied for user …` | Wrong `DB_USER` / `DB_PASSWORD`; both need the `u636932635_` prefix |
| Signed out right after signing in | `TRUST_PROXY` is missing, so Express thinks the request is plain HTTP and drops the secure cookie |
| Product images disappear after a deploy | Uploads live in the app folder; back up `public/uploads` (File Manager) before redeploying |
