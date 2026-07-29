# ManageMate PMS

**ManageMate** is a modern, full-stack Property Management System (PMS) built for landlords, property managers, and real estate agencies. It manages tenants, units, properties, rent collection, arrears tracking, invoicing, receipting, and financial reporting — all from a clean, responsive dashboard.

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Templating | EJS |
| Database | PostgreSQL (Neon Serverless) |
| Sessions | express-session + connect-pg-simple |
| Security | helmet, express-rate-limit |
| Compression | compression |
| QR Codes | qrcode |
| CSS | Vanilla CSS (Inter font, CSS custom properties) |
| Hosting | Vercel (serverless) + Neon (database) |

---

## Project Structure

```
PMS2/
├── api/
│   └── index.js              ← Vercel serverless entry point
├── src/
│   ├── app.js                ← Express app setup (middleware, routes)
│   ├── server.js             ← Local dev server (app.listen)
│   ├── config/
│   │   ├── env.js            ← Environment variable loader
│   │   ├── session.js        ← Session middleware factory
│   │   └── rateLimiter.js    ← Login rate limiter
│   ├── controllers/          ← 15 route handler modules
│   │   ├── authController.js
│   │   ├── dashboardController.js
│   │   ├── landlordController.js
│   │   ├── propertyController.js
│   │   ├── unitController.js
│   │   ├── tenantController.js
│   │   ├── rentController.js
│   │   ├── expenseController.js
│   │   ├── invoiceController.js
│   │   ├── receiptController.js
│   │   ├── reportController.js
│   │   ├── settingsController.js
│   │   ├── archiveController.js
│   │   ├── userController.js
│   │   └── verificationController.js
│   ├── routes/               ← 17 route definition files
│   │   ├── index.js          ← Mounts all routes on Express app
│   │   └── [entity]Routes.js
│   ├── middleware/
│   │   ├── auth.js           ← requireAuth, requireAdmin guards
│   │   ├── errorHandler.js   ← 404 + global error handlers
│   │   └── requestLogger.js  ← Slow-request + error logger
│   ├── services/
│   │   ├── auditService.js   ← Audit log writer
│   │   ├── rentService.js    ← Ledger sync + arrears logic
│   │   └── settingsService.js← Settings loader
│   └── utils/
│       ├── cache.js          ← In-process TTL cache (30s)
│       ├── helpers.js        ← Shared utility functions
│       ├── idGenerator.js    ← Prefixed ID generator
│       ├── pagination.js     ← Pagination helper
│       ├── password.js       ← bcrypt wrapper
│       ├── validation.js     ← Input validators
│       └── verification.js   ← QR code + document verification
├── database/
│   └── pool.js               ← pg.Pool singleton (serverless-optimised)
├── views/
│   ├── dashboard.ejs         ← Main SPA-style dashboard
│   └── login.ejs             ← Login page
├── public/
│   ├── css/
│   │   └── dashboard.css     ← All application styles
│   └── js/
│       └── dashboard.js      ← All frontend JS (~1,400 lines)
├── vercel.json               ← Vercel deployment config
├── .env.example              ← Environment variable template
├── .vercelignore             ← Vercel upload exclusions
├── package.json
└── schema.sql                ← Database schema (reference only)
```

---

## Quick Start (Local Development)

### Prerequisites
- Node.js 18 or higher
- A Neon PostgreSQL database (or any PostgreSQL 12+ instance)
- Git

### 1. Clone and install

```bash
git clone https://github.com/andrewappssystems/PMS2.1.git
cd PMS2.1
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
SESSION_SECRET=your-random-64-char-secret
NODE_ENV=development
PORT=3000
```

### 3. Set up database

Run the SQL schema in your Neon SQL console (or any PostgreSQL client):

```bash
# Copy the contents of schema.sql into your Neon SQL console and execute
```

### 4. Start development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Create your first admin user

Use the included password hash generator:

```bash
node -e "
const bcrypt = require('bcrypt') || require('bcryptjs');
bcrypt.hash('your-password', 12).then(h => console.log(h));
"
```

Then insert via Neon SQL console:

```sql
INSERT INTO users (user_id, username, password, full_name, role)
VALUES ('USR001', 'admin', '<bcrypt-hash>', 'Administrator', 'Admin');
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ Yes | Neon PostgreSQL connection string |
| `SESSION_SECRET` | ✅ Yes | Random secret for session cookies (32+ chars) |
| `NODE_ENV` | ✅ Yes | Set to `production` on Vercel |
| `PORT` | ❌ No | Server port for local dev (default: 3000) |
| `SKIP_DB_CHECK` | ❌ No | Set `true` on Vercel to skip startup DB probe |
| `VERCEL_URL` | Auto | Auto-injected by Vercel (do not set manually) |

---

## Production Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the complete Vercel + Neon deployment guide.

---

## Key Features

- **Multi-property management** — Properties → Units → Tenants hierarchy
- **Rent collection** — Record payments with FIFO balance ledger
- **Arrears tracking** — Auto-marks tenants overdue on 5th of each month
- **Invoicing & Receipting** — Generate PDF-quality HTML documents with QR verification
- **Financial Reports** — Portfolio report, landlord statements, tenant statements
- **Audit Logs** — Every system action is logged with user, timestamp, and details
- **User management** — Admin and Staff roles
- **Settings** — Company branding, rent charge injection, system configuration

---

## Troubleshooting

### Dashboard shows dashes / data not loading
- Check `DATABASE_URL` is set correctly in Vercel environment variables
- Check Neon database is not paused (free tier auto-pauses after inactivity)
- Hard refresh browser: `Ctrl+Shift+R`

### Login fails
- Verify `SESSION_SECRET` is set in Vercel environment variables
- Ensure `NODE_ENV=production` is set

### PDF / Reports return errors
- Verify `DATABASE_URL` is set and Neon is reachable
- Check Vercel function logs for SQL errors

### Cold start is slow
- Expected on Vercel's free/hobby tier — first request after inactivity takes 2-5s
- Subsequent requests are fast
