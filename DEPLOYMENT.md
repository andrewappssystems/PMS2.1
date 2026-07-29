# ManageMate PMS — Vercel + Neon Deployment Guide

## Overview

This guide walks you through deploying ManageMate PMS to **Vercel** (serverless hosting) using **Neon** (serverless PostgreSQL). Every command and every step is explained.

**Estimated time:** 20–30 minutes for a first deployment.

---

## Prerequisites

Before starting, ensure you have:

| Requirement | Where to get it |
|-------------|-----------------|
| Node.js 18+ installed | https://nodejs.org |
| Git installed | https://git-scm.com |
| GitHub account | https://github.com |
| Vercel account | https://vercel.com (free) |
| Neon account | https://neon.tech (free) |

---

## Part 1: Neon Database Setup

### Step 1: Create a Neon Project

1. Go to [https://console.neon.tech](https://console.neon.tech)
2. Click **"New Project"**
3. Name it `managemate` (or any name)
4. Choose a region close to your users (e.g., `us-east-1` or `eu-west-1`)
5. Click **"Create Project"**

### Step 2: Get the Connection String

1. In your Neon project dashboard, click **"Connection Details"**
2. Select **Connection string** format
3. Copy the string — it looks like:
   ```
   postgresql://username:password@ep-cool-name-123456.us-east-2.aws.neon.tech/dbname?sslmode=require
   ```
4. Save this — you'll need it in Step 7

### Step 3: Create the Database Schema

1. In Neon dashboard, click **"SQL Editor"**
2. Open the file `schema.sql` from this project
3. Copy the entire contents
4. Paste into the Neon SQL Editor
5. Click **"Run"**
6. Verify success — all tables should be created

### Step 4: Create the First Admin User

In the Neon SQL Editor, run:

```sql
-- First, generate a bcrypt hash of your password
-- Run this in your terminal:
-- node -e "const b=require('bcrypt');b.hash('YourPassword123',12).then(h=>console.log(h))"
-- Then replace <HASH_HERE> with the output

INSERT INTO users (user_id, username, password, full_name, role, email)
VALUES (
  'USR001',
  'admin',
  '<HASH_HERE>',
  'Administrator',
  'Admin',
  'admin@yourcompany.com'
);
```

---

## Part 2: GitHub Repository Setup

### Step 5: Push Your Code to GitHub

If your code is not yet on GitHub:

```bash
# In your project directory:
git init
git add .
git commit -m "Initial commit — ManageMate PMS"
git branch -M main

# Create a new repo on GitHub at https://github.com/new
# Then connect it:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

If code is already on GitHub, just ensure latest changes are pushed:

```bash
git add .
git commit -m "Add Vercel deployment config"
git push
```

### Step 6: Verify Required Files Are Committed

Make sure these files are in your repository:

```
✅ api/index.js
✅ vercel.json
✅ .env.example
✅ .vercelignore
✅ src/app.js
✅ src/server.js
✅ database/pool.js
✅ package.json
✅ public/css/dashboard.css
✅ public/js/dashboard.js
✅ views/dashboard.ejs
✅ views/login.ejs
```

---

## Part 3: Vercel Deployment

### Step 7: Install Vercel CLI (Optional — for CLI deployment)

```bash
npm install -g vercel
```

Verify installation:

```bash
vercel --version
# Should output: Vercel CLI X.X.X
```

### Step 8: Create a Vercel Project

**Option A — GitHub Integration (Recommended)**

1. Go to [https://vercel.com/new](https://vercel.com/new)
2. Click **"Import Git Repository"**
3. Connect your GitHub account if not already connected
4. Select your `PMS2.1` repository from the list
5. Click **"Import"**

**Option B — Vercel CLI**

```bash
cd /path/to/your/PMS2
vercel login
vercel
```

Follow the prompts:
- Set up and deploy? → **Y**
- Which scope? → Select your account
- Link to existing project? → **N**
- Project name? → `managemate`
- In which directory is your code located? → `./`

### Step 9: Configure Build Settings

In the Vercel dashboard for your project:

1. Go to **Settings → General**
2. Verify:
   - **Framework Preset**: `Other`
   - **Build Command**: Leave blank (or `npm run vercel-build`)
   - **Output Directory**: Leave blank
   - **Install Command**: `npm install`
   - **Root Directory**: `./`

> The `vercel.json` file handles all routing automatically. No additional build configuration is needed.

### Step 10: Add Environment Variables

This is the **most important step**. Missing variables will cause the app to fail.

1. In Vercel dashboard → **Settings → Environment Variables**
2. Add each variable below:

| Name | Value | Environment |
|------|-------|-------------|
| `DATABASE_URL` | Your Neon connection string | Production, Preview, Development |
| `SESSION_SECRET` | Random 64-char string (see below) | Production, Preview, Development |
| `NODE_ENV` | `production` | Production |
| `SKIP_DB_CHECK` | `true` | Production, Preview |

**Generating a secure SESSION_SECRET:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and use it as `SESSION_SECRET`.

3. Click **"Save"** after adding all variables

### Step 11: Deploy

**Via Dashboard:**
1. Go to **Deployments** tab
2. Click **"Redeploy"** on the latest deployment
3. Watch the build logs

**Via CLI:**
```bash
vercel --prod
```

**Via Git push (automatic):**
```bash
git push origin main
# Vercel automatically redeploys on every push to main
```

### Step 12: Verify Deployment

1. After deployment completes, click the deployment URL (e.g., `https://managemate.vercel.app`)
2. You should see the ManageMate login page
3. Log in with the admin credentials you created in Step 4
4. Verify the dashboard loads with data

**Test these endpoints:**
```
✅ GET  /               → redirects to /login or /dashboard
✅ GET  /login          → login page renders
✅ POST /login          → submits login form
✅ GET  /dashboard      → dashboard renders (after login)
✅ GET  /api/landlords  → returns JSON
✅ GET  /api/tenants    → returns JSON
✅ GET  /health         → returns {"status":"ok",...}
```

---

## Part 4: Custom Domain (Optional)

### Step 13: Add Your Domain

1. In Vercel dashboard → **Settings → Domains**
2. Click **"Add"**
3. Enter your domain: `pms.yourcompany.com`
4. Follow Vercel's instructions to add a DNS record:
   - **Type**: `CNAME`
   - **Name**: `pms` (or `@` for root domain)
   - **Value**: `cname.vercel-dns.com`
5. DNS propagation takes 5–30 minutes

### SSL Certificate

Vercel automatically provisions a free SSL certificate via Let's Encrypt. No action required.

---

## Part 5: Ongoing Operations

### Updating the Application

```bash
# Make your changes locally
git add .
git commit -m "fix: description of change"
git push origin main
# Vercel automatically deploys the new version in ~30 seconds
```

### Viewing Logs

**In Vercel Dashboard:**
1. Go to **Deployments** → click a deployment
2. Click **"Functions"** tab → select `api/index`
3. View real-time logs

**Via CLI:**
```bash
vercel logs --follow
```

### Rolling Back

If a deployment breaks the app:

1. Go to **Deployments** tab in Vercel dashboard
2. Find the last working deployment
3. Click the **⋯** menu → **"Promote to Production"**

### Rollback via CLI:
```bash
vercel rollback
```

---

## Part 6: Monitoring

### Vercel Analytics (Optional)

Enable in **Settings → Analytics** for page views and performance data.

### Database Monitoring (Neon)

1. Go to [console.neon.tech](https://console.neon.tech)
2. Click **"Monitoring"** to see:
   - Active connections
   - Query history
   - Storage usage

### Health Check

Vercel uptime monitors can ping your health endpoint:

```
GET https://your-app.vercel.app/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "env": "production",
  "uptime": "0s"
}
```

> **Note:** `uptime` will always be very low (seconds) on Vercel because each request may start a new serverless function instance. This is normal.

---

## Troubleshooting

### "Application Error" on Vercel

**Cause:** Missing environment variables or database unreachable.

**Fix:**
1. Check Vercel → Settings → Environment Variables — ensure `DATABASE_URL` and `SESSION_SECRET` are set
2. Check Neon dashboard — ensure database is not paused
3. Check Vercel function logs for the exact error

### Login page loads but login fails

**Cause:** `SESSION_SECRET` missing or Neon `session` table doesn't exist.

**Fix:**
1. Verify `SESSION_SECRET` is set in Vercel environment variables
2. Run this in Neon SQL Editor to ensure the session table exists:
```sql
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
```

### Dashboard shows dashes/zeros (no data)

**Cause:** Database connected but tables are empty or schema mismatch.

**Fix:**
1. Verify schema was applied (run schema.sql in Neon)
2. Hard refresh browser: `Ctrl+Shift+R` or `Cmd+Shift+R`
3. Check Vercel logs for SQL errors

### "Error: could not determine data type of parameter $1"

**Cause:** PostgreSQL type inference issue with date parameters.

**Status:** Already fixed in `reportController.js` — all date parameters use `$1::text::timestamp` casting.

### Static files (CSS/JS) not loading

**Cause:** Vercel routes not serving public files correctly.

**Fix:**
Verify `vercel.json` routes are in place:
```json
{ "src": "/css/(.*)", "dest": "/public/css/$1" }
{ "src": "/js/(.*)", "dest": "/public/js/$1" }
```

If static files still fail, hard-clear browser cache: DevTools → Network → Disable cache → Reload.

### Neon database paused (free tier)

Neon free tier databases pause after 5 minutes of inactivity.

**Symptom:** First request after idle returns an error or is very slow (5–10s).

**Fix:** 
- Upgrade to Neon's paid tier for always-on connections
- Or accept the cold start delay (the app resumes automatically after the first request)

### "Cannot find module" errors

**Cause:** Missing dependency not in `package.json`.

**Fix:**
```bash
npm install missing-package
git add package.json package-lock.json
git commit -m "fix: add missing dependency"
git push
```

### CORS errors in browser console

**Cause:** If you're accessing the API from a different domain.

**Fix:** The app uses `helmet` which handles most security headers. CORS is not needed for same-origin requests (browser + server on same Vercel domain).

---

## Serverless Limitations to Be Aware Of

| Limitation | Impact on ManageMate | Mitigation |
|------------|---------------------|------------|
| **No persistent memory** | In-process cache resets on cold start | Cache TTL is 30s — minor performance only |
| **No `setInterval`** | Removed Render keep-alive timer | Not needed on Vercel |
| **Max 3 DB connections** | Neon free tier limit | Pool configured to max:3 |
| **Cold start latency** | First request after idle: 2–5s | Accept or upgrade to Vercel Pro |
| **Max function size** | 50MB compressed | App is well under limit |
| **Function timeout** | Default 10s (Hobby), 60s (Pro) | PDF reports may need Pro tier for large portfolios |

---

## Security Checklist

Before going live, verify:

- [ ] `SESSION_SECRET` is a random 32+ character string (not the default)
- [ ] `.env` is in `.gitignore` and never committed
- [ ] `NODE_ENV=production` is set in Vercel
- [ ] `DATABASE_URL` uses `?sslmode=require`
- [ ] All admin users have strong passwords
- [ ] Neon database does not have public access beyond the connection string
- [ ] Vercel project is set to require authentication for preview deployments (if needed)

---

## Estimated Costs

| Service | Free Tier | Paid Tier |
|---------|-----------|-----------|
| **Vercel** | 100GB bandwidth/month, unlimited deployments | Pro: $20/month — removes limits, adds team features |
| **Neon** | 0.5GB storage, 1 compute unit, auto-pause | Launch: $19/month — always-on, more storage |
| **Custom Domain** | $0 (bring your own) | ~$12/year from any domain registrar |

**Total for small deployment:** $0/month (free tiers)  
**Total for production use:** ~$39/month (Vercel Pro + Neon Launch)

---

## Quick Command Reference

```bash
# Install Vercel CLI
npm install -g vercel

# Login to Vercel
vercel login

# Deploy to preview
vercel

# Deploy to production
vercel --prod

# View production logs
vercel logs --follow

# List deployments
vercel ls

# Rollback
vercel rollback

# Pull environment variables to local .env
vercel env pull .env.local

# Generate a secure SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Test health endpoint
curl https://your-app.vercel.app/health
```
