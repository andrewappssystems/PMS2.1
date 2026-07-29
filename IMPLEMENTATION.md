# ManageMate PMS — Implementation Guide

## Architecture Overview

ManageMate is a **server-rendered Express + EJS application** deployed as a Vercel serverless function.  
It follows a clean **MVC (Model-View-Controller)** pattern with explicit service and utility layers.

```
Browser Request
      │
      ▼
  Vercel Edge  ──── Static assets (.css, .js) ──── Served directly
      │
      ▼
  api/index.js  (Vercel serverless function)
      │
      ▼
  src/app.js  (Express middleware chain)
      │
      ├── helmet (security headers)
      ├── compression (gzip)
      ├── express.static (public/)
      ├── express.urlencoded + express.json (body parsing)
      ├── requestLogger (slow/error logging)
      ├── session (express-session + connect-pg-simple → Neon)
      │
      ▼
  src/routes/index.js  (route multiplexer)
      │
      ▼
  [entity]Routes.js  (route definitions)
      │
      ├── middleware/auth.js  (requireAuth, requireAdmin)
      │
      ▼
  [entity]Controller.js  (request handlers)
      │
      ├── database/pool.js  (SQL queries via pg.Pool)
      ├── services/*.js  (complex business logic)
      └── utils/*.js  (helpers, cache, IDs, etc.)
      │
      ▼
  res.json() or res.render('dashboard', data)
      │
      ▼
  views/dashboard.ejs or views/login.ejs
      │
      ▼
  HTML → Browser
```

---

## Request Lifecycle

### API Request (e.g., `GET /api/tenants`)

1. Vercel routes request to `api/index.js`
2. Express processes middleware chain in `app.js`
3. `requestLogger` records start time
4. `express-session` loads session from Neon `session` table
5. Route matched in `tenantRoutes.js`
6. `requireAuth` middleware checks `req.session.user`
7. `tenantController.list()` executes SQL via pool
8. Controller calls `res.json(rows)`
9. `requestLogger` records duration on `res.finish`
10. Response sent to browser

### Page Request (e.g., `GET /dashboard`)

1–6. Same as above
7. `dashboardController.index()` queries stats
8. Controller calls `res.render('dashboard', { user, stats })`
9. EJS renders `views/dashboard.ejs` with injected data
10. Full HTML sent to browser

### Static Asset (e.g., `GET /css/dashboard.css`)

1. Vercel matches `/css/(.*)` route in `vercel.json`
2. Serves file directly from `public/css/` — **Express never called**
3. Response includes `Cache-Control: public, max-age=86400`

---

## Folder Responsibilities

### `api/`
Vercel serverless entry point. Contains `index.js` which exports the Express `app` object. Vercel maps every HTTP request to this function. **Do not add business logic here.**

### `src/app.js`
The Express application factory. Configures all middleware in the correct order and mounts all routes. This is the single source of truth for application setup.

### `src/server.js`
Used only for **local development**. Calls `app.listen()`. On Vercel, this file is bypassed entirely.

### `src/config/`
Application-level configuration modules:
- `env.js` — Loads and validates all environment variables. Every other module imports from here instead of reading `process.env` directly.
- `session.js` — Creates the session middleware factory. Uses `connect-pg-simple` to store sessions in the Neon `session` table, making them persistent across serverless cold starts.
- `rateLimiter.js` — Login rate limiter (10 attempts per 15 minutes).

### `src/controllers/`
One file per feature domain. Each controller exports named async functions used as Express route handlers. Controllers are responsible for:
- Parsing `req.params`, `req.body`, `req.query`
- Executing SQL via `pool.query()`
- Calling services for complex logic
- Calling `auditService.logAudit()` for write operations
- Sending responses: `res.json()` or `res.render()`

### `src/routes/`
One file per feature domain. Each file creates an Express Router, defines routes (method + path + middleware + controller), and exports the router. `index.js` mounts all routers on the main app.

### `src/middleware/`
- `auth.js` — `requireAuth` redirects unauthenticated requests. `requireAdmin` blocks non-admin users from admin endpoints.
- `errorHandler.js` — `notFoundHandler` handles 404s. `globalErrorHandler` catches all unhandled errors.
- `requestLogger.js` — Logs slow requests (>2s) and all errors to console.

### `src/services/`
Complex multi-step business logic extracted from controllers:
- `rentService.js` — The ledger sync engine. `syncLedgers()` injects monthly rent charges and computes FIFO balances. `getDueStatus()` implements the 5th-of-month arrears rule.
- `auditService.js` — `logAudit()` writes action records to the `archive` table.
- `settingsService.js` — `getSettings()` loads key-value pairs from the `settings` table.

### `src/utils/`
Pure utility functions with no side effects:
- `cache.js` — In-process Map-based TTL cache (30 second TTL). Resets on cold start. Used for dashboard stats.
- `idGenerator.js` — Generates prefixed IDs (e.g., `TNT2024001`, `PROP001`).
- `password.js` — `hashPassword()` and `verifyPassword()` using bcrypt.
- `verification.js` — Generates QR codes and verification records for documents.
- `pagination.js` — Page/offset calculation helper.
- `validation.js` — Input sanitization helpers.
- `helpers.js` — Shared formatting functions.

### `database/pool.js`
Single shared `pg.Pool` instance used by all controllers and services. Pool settings are optimised for Neon's free tier (max 3 connections). `allowExitOnIdle: true` ensures serverless functions can terminate cleanly.

### `views/`
Two EJS templates:
- `login.ejs` — Login page with ManageMate branding.
- `dashboard.ejs` — The main application shell. All features render within this single template driven by `dashboard.js` fetching API data.

### `public/`
Static frontend assets:
- `css/dashboard.css` — All application styles (37KB). Uses CSS custom properties, Inter font.
- `js/dashboard.js` — All frontend JS (~1,400 lines). Handles all CRUD modals, API calls, and UI state.

---

## Route Flow

### Adding a new route

1. Create controller function in `src/controllers/yourController.js`:
```js
exports.list = async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM your_table');
  res.json(rows);
};
```

2. Add route in `src/routes/yourRoutes.js`:
```js
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/yourController');
router.get('/api/your-resource', requireAuth, ctrl.list);
```

3. Mount router in `src/routes/index.js`:
```js
const yourRoutes = require('./yourRoutes');
app.use('/', yourRoutes);
```

---

## Authentication Flow

1. User submits login form → `POST /login`
2. `authController.login()` queries users table by username
3. `password.verifyPassword()` compares submitted password to bcrypt hash
4. On success: `req.session.user = { user_id, username, full_name, role }`
5. Session is persisted to Neon `session` table by `connect-pg-simple`
6. User is redirected to `/dashboard`
7. Subsequent requests: `requireAuth` reads `req.session.user` — if present, proceeds; if absent, redirects to `/login`
8. On logout: `req.session.destroy()` removes session from DB

---

## Arrears / Ledger Logic

The core financial logic lives in `src/services/rentService.js`:

### Rule: 5th-of-Month Arrears Lock-in
```
Every month on the 5th:
  unpaid balance from previous month → locked as "Arrears"
  new monthly rent charge → injected into ledger
```

### FIFO Balance Calculation
```
newBalance = (rentAmount + previousBalance) - amountPaid
```
- `newBalance > 0` → tenant is in arrears
- `newBalance = 0` → fully paid
- `newBalance < 0` → tenant has a credit (offset against next month)

### `rent_balances` table
Stores `carried_balance` per tenant — the running total owed. Updated on every payment via `rentController.createV2()`.

---

## Database Flow

All database access uses the shared `pool` from `database/pool.js`.

```js
// Pattern used in every controller:
const { rows } = await pool.query(
  'SELECT * FROM tenants WHERE tenant_id = $1',
  [req.params.id]
);
```

- Parameterised queries prevent SQL injection
- All date parameters use `$1::text::timestamp` to resolve type ambiguity with Neon
- Pool handles connection acquisition/release automatically

---

## Session Flow

Sessions are database-backed (Neon `session` table):

```
Request arrives → connect-pg-simple reads session row by cookie SID
              → populates req.session
              → controller reads req.session.user
              → response sends Set-Cookie (if new session)
              → connect-pg-simple saves session row
```

This works correctly across multiple Vercel function instances because the session data lives in the database, not in process memory.

---

## Error Handling

```
Controller throws → globalErrorHandler catches
                 → API routes: 500 JSON response
                 → HTML routes: renders login.ejs with error message
                 → logs to console (visible in Vercel function logs)

Route not found  → notFoundHandler
                 → API routes: 404 JSON
                 → HTML routes: redirect to /
```

---

## Code Conventions

- `'use strict'` at top of every file
- `async/await` for all async operations (no callbacks)
- `try/catch` in every controller
- Parameterised SQL — never string interpolation in queries
- One controller per domain (landlords, tenants, units, etc.)
- One route file per domain
- IDs generated with `idGenerator.js` (never database sequences for portable IDs)
- Audit log on every write operation (`auditService.logAudit()`)

---

## Performance Notes

### In-process cache (`utils/cache.js`)
- 30-second TTL
- Used for dashboard stats
- Resets on every Vercel cold start
- This is acceptable — stats recalculate from DB on first request after idle

### Static assets
- Served by Vercel edge network directly (not Express)
- Cache-Control: 1 day for CSS/JS

### Database connections
- Max 3 concurrent connections (Neon free tier limit)
- `allowExitOnIdle: true` prevents connection leaks in serverless

---

## Maintenance Guide

### Adding a new setting key
1. Insert row in `settings` table: `INSERT INTO settings (key, value) VALUES ('my_key', 'my_value')`
2. Read in controller: `const { getSettings } = require('../services/settingsService'); const cfg = await getSettings();`

### Changing a report calculation
- Report controllers: `src/controllers/reportController.js`
- All SQL is readable and parameterised — edit the query directly

### Adding a new user role
1. Update `requireAdmin` in `src/middleware/auth.js` to support the new role
2. Add UI conditional in `dashboard.ejs` if needed

### Updating the database schema
1. Write a migration SQL statement
2. Run it in Neon SQL console
3. Update relevant controller SQL
4. No ORM to regenerate — direct SQL only
