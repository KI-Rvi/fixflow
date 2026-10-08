# FixFlow

Field-service and repair management. Customers book repairs with photos, managers dispatch the best-matched technician, technicians log diagnosis and parts, and everyone sees changes live.

## Run it

```bash
docker compose up -d                          # PostGIS, Redis, AI service
cd server && cp .env.example .env && npm install
npx prisma db push && npx prisma db seed      # schema + demo data
npm run dev                                   # API on :4000
cd ../client && npm install && npm run dev    # app on :5173
```

Demo logins (password `password123`): `manager@fixflow.dev`, `ava@fixflow.dev` (HVAC, electrical), `ben@fixflow.dev` (appliances), `customer@fixflow.dev`.
Technicians are seeded near the `HOME` coordinates in `server/prisma/seed.ts`. Set them to your city, then use "Use my location" when booking.

Try it: send a request as the customer (add a photo), watch it appear for the manager, assign a ranked technician, then log in as that technician and save progress with a part. Each change reaches the others instantly.

## What is inside

- `server/` Express + TypeScript API. Prisma on PostgreSQL with PostGIS distance queries, JWT + bcrypt, role-based access, Zod validation, Multer uploads, Socket.IO, Redis cache.
- `ai-service/` FastAPI triage. Keyword classifier for category and urgency, OpenCV checks for blurry or dark photos.
- `client/` React, TypeScript, Tailwind v4, Redux Toolkit, Recharts.

## How the main workflows work

- **Lifecycle:** NEW, SCHEDULED, IN_PROGRESS, AWAITING_PARTS, COMPLETED (cancel from NEW or SCHEDULED). Transitions are enforced in `routes.ts`.
- **Dispatch ranking:** skill is a hard filter. Score = 60 x proximity (PostGIS km, zero at 50 km or more) + 40 x spare capacity (open jobs against `maxOpenJobs`). Each candidate gets their first free 2-hour weekday slot (9, 11, 13, 15).
- **No double booking:** assignment runs in a serializable transaction and rejects overlapping slots.
- **Parts:** stock is decremented atomically and the update fails if stock is short.
- **Warranty:** checked against the equipment's `warrantyUntil` when the request is created.
- **Real time:** sockets authenticate with the JWT and join `user:<id>` and `role:<ROLE>` rooms. `publishTicket` stores notifications, clears the analytics cache, and emits `ticket:updated`.

## API (all under /api)

| Route | Roles | Purpose |
| --- | --- | --- |
| POST /auth/register, /auth/login | public | Customer sign-up, login |
| GET, POST /equipment; GET /equipment/:id/history | customer (history: all) | Equipment, warranty, service history |
| POST /tickets (multipart `images`) | customer | Create request, AI triage, warranty check |
| GET /tickets, GET /tickets/:id | all (scoped to the user) | List and detail |
| GET /tickets/:id/suggestions | manager | Ranked technicians with free slots |
| POST /tickets/:id/assign | manager | Book technician and slot |
| PATCH /tickets/:id/progress | technician | Status, diagnosis, resolution, parts |
| POST /tickets/:id/cancel | customer, manager | Cancel before work starts |
| GET /parts | technician, manager | Inventory |
| GET /analytics/summary | manager | Dashboard numbers (Redis, 30 s) |
| GET /notifications | all | Stored notifications |

## Next steps

Embedded Mapbox/Google map (jobs link out to Google Maps today), equipment and parts admin screens, a trained model behind `classify()` in `ai-service/main.py`, tests, Prisma migrations instead of `db push`.
