import { Router, type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { z } from "zod";
import { Prisma, type Status } from "@prisma/client";
import { SLOT_MIN, availableSlots, rankTechnicians } from "./assignment";
import { cached, geocodeAddress, prisma, publishTicket, triage } from "./lib";
import { HttpError, auth, requireRole, sign, validate, type AuthUser } from "./middleware";

const r = Router();
const upload = multer({ dest: "uploads/", limits: { fileSize: 8_000_000, files: 4 } });
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

// Ticket lifecycle, enforced on the server so no client can skip a step.
const FLOW: Record<Status, Status[]> = {
  NEW: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["AWAITING_PARTS", "COMPLETED"],
  AWAITING_PARTS: ["IN_PROGRESS"],
  COMPLETED: [],
  CANCELLED: [],
};
const guard = (from: Status, to: Status) => {
  if (!FLOW[from].includes(to)) throw new HttpError(409, `A ${from.toLowerCase()} request cannot move to ${to.toLowerCase()}`);
};

async function loadTicket(id: string, u: AuthUser) {
  const t = await prisma.ticket.findUnique({
    where: { id },
    include: {
      customer: { select: { name: true } },
      technician: { include: { user: { select: { name: true } } } },
      appointment: true,
      equipment: true,
      parts: { include: { part: true } },
      events: { orderBy: { at: "asc" } },
    },
  });
  if (!t || !(u.role === "MANAGER" || t.customerId === u.id || t.technician?.userId === u.id)) {
    throw new HttpError(404, "Request not found");
  }
  return t;
}

// ---- Auth ----
const credentials = z.object({ email: z.string().email(), password: z.string().min(8) });
const session = (u: { id: string; name: string; role: AuthUser["role"] }) => ({
  token: sign(u),
  user: { id: u.id, name: u.name, role: u.role },
});

r.post("/auth/register", validate(credentials.extend({ name: z.string().min(2) })), wrap(async (req, res) => {
  const { email, password, name } = req.body;
  const user = await prisma.user.create({ data: { email, name, passwordHash: await bcrypt.hash(password, 10), role: "CUSTOMER" } });
  res.status(201).json(session(user));
}));

r.post("/auth/login", validate(credentials), wrap(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) throw new HttpError(401, "Email or password is wrong");
  res.json(session(user));
}));

// ---- Equipment, warranty, service history ----
const newEquipment = z.object({
  category: z.string().min(2),
  brand: z.string().min(1),
  modelName: z.string().min(1),
  serial: z.string().min(3),
  purchasedAt: z.coerce.date(),
  warrantyMonths: z.number().int().min(0).max(120),
});

r.get("/equipment", auth, requireRole("CUSTOMER"), wrap(async (req, res) => {
  res.json(await prisma.equipment.findMany({ where: { ownerId: req.user!.id } }));
}));

r.post("/equipment", auth, requireRole("CUSTOMER"), validate(newEquipment), wrap(async (req, res) => {
  const { warrantyMonths, ...data } = req.body as z.infer<typeof newEquipment>;
  const warrantyUntil = new Date(data.purchasedAt);
  warrantyUntil.setMonth(warrantyUntil.getMonth() + warrantyMonths);
  res.status(201).json(await prisma.equipment.create({ data: { ...data, ownerId: req.user!.id, warrantyUntil } }));
}));

r.get("/equipment/:id/history", auth, wrap(async (req, res) => {
  const eq = await prisma.equipment.findUnique({
    where: { id: req.params.id },
    include: { tickets: { orderBy: { createdAt: "desc" }, include: { parts: { include: { part: true } } } } },
  });
  if (!eq || (req.user!.role === "CUSTOMER" && eq.ownerId !== req.user!.id)) throw new HttpError(404, "Equipment not found");
  res.json(eq);
}));

const slotQuery = z.object({ category: z.string().min(2), lat: z.coerce.number(), lng: z.coerce.number() });

r.get("/slots", auth, requireRole("CUSTOMER"), wrap(async (req, res) => {
  const q = slotQuery.safeParse(req.query);
  if (!q.success) throw new HttpError(400, "category, lat and lng are required");
  res.json(await availableSlots(q.data));
}));

// ---- Technicians, tickets, geocoding ----
const newTechnician = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(8),
  skills: z.array(z.string().min(2)).min(1),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  maxOpenJobs: z.coerce.number().int().min(1).max(20).default(5),
});

r.post("/technicians", auth, requireRole("MANAGER"), validate(newTechnician), wrap(async (req, res) => {
  const b = req.body as z.infer<typeof newTechnician>;
  const exists = await prisma.user.findUnique({ where: { email: b.email } });
  if (exists) throw new HttpError(409, "A technician with that email already exists");
  const user = await prisma.user.create({
    data: {
      email: b.email,
      name: b.name,
      passwordHash: await bcrypt.hash(b.password, 10),
      role: "TECHNICIAN",
      technician: { create: { skills: b.skills, lat: b.lat, lng: b.lng, maxOpenJobs: b.maxOpenJobs } },
    },
    include: { technician: true },
  });
  res.status(201).json(user);
}));

const newTicket = z.object({
  title: z.string().min(3),
  description: z.string().min(10),
  address: z.string().min(3),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  equipmentId: z.string().uuid().optional(),
  category: z.string().optional(),
  priority: z.coerce.number().int().min(1).max(4).optional(),
  preferredStart: z.coerce.date().optional(),
});

r.post("/tickets", auth, requireRole("CUSTOMER"), upload.array("images", 4), validate(newTicket), wrap(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const b = req.body as z.infer<typeof newTicket>;

  let underWarranty = false;
  if (b.equipmentId) {
    const eq = await prisma.equipment.findFirst({ where: { id: b.equipmentId, ownerId: req.user!.id } });
    if (!eq) throw new HttpError(400, "That equipment is not on your account");
    underWarranty = eq.warrantyUntil > new Date();
  }

  let lat = b.lat;
  let lng = b.lng;
  if ((lat == null || lng == null) && b.address) {
    const geo = await geocodeAddress(b.address);
    if (!geo) throw new HttpError(400, "Address could not be geocoded. Share your location or add a valid address.");
    lat = geo.lat;
    lng = geo.lng;
  }
  if (lat == null || lng == null) throw new HttpError(400, "Location is required");

  const ai = await triage(`${b.title}. ${b.description}`, files[0]);
  const category = b.category ?? ai?.category ?? "GENERAL";
  const wanted = b.preferredStart?.toISOString();
  if (wanted) {
    const open = await availableSlots({ category, lat, lng });
    if (!open.some(s => s.startsAt === wanted)) throw new HttpError(409, "That time was just taken. Pick another slot.");
  }
  const ticket = await prisma.ticket.create({
    data: {
      ...b,
      lat,
      lng,
      customerId: req.user!.id,
      underWarranty,
      category,
      priority: b.priority ?? ai?.priority ?? 2,
      preferredStart: b.preferredStart ?? null,
      aiLabel: ai?.category,
      aiConfidence: ai?.confidence,
      aiImage: ai?.image ?? undefined,
      images: files.map(f => `/uploads/${f.filename}`),
      events: { create: { toStatus: "NEW" } },
    },
  });
  await publishTicket(ticket.id, `New request: ${ticket.title}`);
  res.status(201).json(ticket);
}));

r.get("/tickets", auth, wrap(async (req, res) => {
  const u = req.user!;
  const where: Prisma.TicketWhereInput =
    u.role === "CUSTOMER" ? { customerId: u.id } : u.role === "TECHNICIAN" ? { technician: { userId: u.id } } : {};
  res.json(
    await prisma.ticket.findMany({
      where,
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        appointment: true,
        customer: { select: { name: true } },
        technician: { include: { user: { select: { name: true } } } },
      },
    }),
  );
}));

r.get("/tickets/:id", auth, wrap(async (req, res) => {
  res.json(await loadTicket(req.params.id, req.user!));
}));

r.get("/tickets/:id/suggestions", auth, requireRole("MANAGER"), wrap(async (req, res) => {
  const t = await loadTicket(req.params.id, req.user!);
  if (t.status !== "NEW") throw new HttpError(409, "This request already has a technician");
  res.json(await rankTechnicians(t));
}));

r.post("/tickets/:id/assign", auth, requireRole("MANAGER"), validate(z.object({ technicianId: z.string().uuid(), startsAt: z.coerce.date() })), wrap(async (req, res) => {
  const { technicianId, startsAt } = req.body as { technicianId: string; startsAt: Date };
  const endsAt = new Date(startsAt.getTime() + SLOT_MIN * 60_000);
  await prisma.$transaction(
    async tx => {
      const t = await tx.ticket.findUnique({ where: { id: req.params.id } });
      if (!t) throw new HttpError(404, "Request not found");
      guard(t.status, "SCHEDULED");
      const clash = await tx.appointment.findFirst({ where: { technicianId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } } });
      if (clash) throw new HttpError(409, "That technician is already booked for this slot");
      await tx.appointment.create({ data: { ticketId: t.id, technicianId, startsAt, endsAt } });
      await tx.ticket.update({
        where: { id: t.id },
        data: { technicianId, status: "SCHEDULED", events: { create: { fromStatus: t.status, toStatus: "SCHEDULED" } } },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  await publishTicket(req.params.id, "A technician has been scheduled");
  res.json(await loadTicket(req.params.id, req.user!));
}));

const progress = z.object({
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "AWAITING_PARTS", "COMPLETED"]),
  diagnosis: z.string().optional(),
  resolution: z.string().optional(),
  parts: z.array(z.object({ partId: z.string().uuid(), qty: z.number().int().min(1) })).default([]),
});

r.patch("/tickets/:id/progress", auth, requireRole("TECHNICIAN"), validate(progress), wrap(async (req, res) => {
  const b = req.body as z.infer<typeof progress>;
  await prisma.$transaction(async tx => {
    const t = await tx.ticket.findFirst({ where: { id: req.params.id, technician: { userId: req.user!.id } } });
    if (!t) throw new HttpError(404, "This job is not assigned to you");
    if (!FLOW[t.status].length) throw new HttpError(409, "This request is closed");
    const changed = b.status !== t.status;
    if (changed) guard(t.status, b.status);
    if (b.status === "COMPLETED" && !(b.resolution ?? t.resolution)) throw new HttpError(400, "Describe what was done before completing the job");

    for (const p of b.parts) {
      const { count } = await tx.part.updateMany({ where: { id: p.partId, stock: { gte: p.qty } }, data: { stock: { decrement: p.qty } } });
      if (!count) throw new HttpError(409, "Not enough stock for that part");
      await tx.partUsage.create({ data: { ticketId: t.id, partId: p.partId, qty: p.qty } });
    }
    await tx.ticket.update({
      where: { id: t.id },
      data: {
        status: b.status,
        diagnosis: b.diagnosis ?? t.diagnosis,
        resolution: b.resolution ?? t.resolution,
        completedAt: b.status === "COMPLETED" ? new Date() : null,
        events: changed ? { create: { fromStatus: t.status, toStatus: b.status } } : undefined,
      },
    });
  });
  await publishTicket(req.params.id, `Update: ${b.status.replace("_", " ").toLowerCase()}`);
  res.json(await loadTicket(req.params.id, req.user!));
}));

r.post("/tickets/:id/cancel", auth, requireRole("CUSTOMER", "MANAGER"), wrap(async (req, res) => {
  const t = await loadTicket(req.params.id, req.user!);
  guard(t.status, "CANCELLED");
  await prisma.$transaction([
    prisma.appointment.deleteMany({ where: { ticketId: t.id } }),
    prisma.ticket.update({
      where: { id: t.id },
      data: { status: "CANCELLED", events: { create: { fromStatus: t.status, toStatus: "CANCELLED" } } },
    }),
  ]);
  await publishTicket(t.id, "Request cancelled");
  res.json({ ok: true });
}));

// ---- Parts, notifications, analytics ----
const newPart = z.object({
  sku: z.string().min(2),
  name: z.string().min(2),
  stock: z.coerce.number().int().min(0).default(0),
  unitCost: z.coerce.number().min(0).default(0),
});

const updatePart = z.object({
  sku: z.string().min(2).optional(),
  name: z.string().min(2).optional(),
  stock: z.coerce.number().int().min(0).optional(),
  delta: z.coerce.number().int().optional(),
  unitCost: z.coerce.number().min(0).optional(),
});

r.get("/parts", auth, requireRole("TECHNICIAN", "MANAGER"), wrap(async (_req, res) => {
  res.json(await prisma.part.findMany({ orderBy: { name: "asc" } }));
}));

r.post("/parts", auth, requireRole("MANAGER"), validate(newPart), wrap(async (req, res) => {
  const b = req.body as z.infer<typeof newPart>;
  const existing = await prisma.part.findUnique({ where: { sku: b.sku } });
  if (existing) throw new HttpError(409, "A part with that SKU already exists");
  res.status(201).json(await prisma.part.create({ data: { ...b, stock: b.stock, unitCost: b.unitCost } }));
}));

r.patch("/parts/:id", auth, requireRole("MANAGER"), validate(updatePart), wrap(async (req, res) => {
  const b = req.body as z.infer<typeof updatePart>;
  const updated = await prisma.part.update({
    where: { id: req.params.id },
    data: {
      ...(b.name ? { name: b.name } : {}),
      ...(b.sku ? { sku: b.sku } : {}),
      ...(b.unitCost != null ? { unitCost: b.unitCost } : {}),
      ...(b.stock != null ? { stock: b.stock } : {}),
      ...(b.delta != null ? { stock: { increment: b.delta } } : {}),
    },
  });
  res.json(updated);
}));

r.get("/notifications", auth, wrap(async (req, res) => {
  res.json(await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { at: "desc" }, take: 30 }));
}));

r.get("/analytics/summary", auth, requireRole("MANAGER"), wrap(async (_req, res) => {
  res.json(
    await cached("analytics:summary", 30, async () => {
      const [byStatus, done, warrantyTickets] = await Promise.all([
        prisma.ticket.groupBy({ by: ["status"], _count: true }),
        prisma.ticket.findMany({ where: { status: "COMPLETED", completedAt: { not: null } }, select: { createdAt: true, completedAt: true } }),
        prisma.ticket.count({ where: { underWarranty: true } }),
      ]);
      const hours = done.map(d => (d.completedAt!.getTime() - d.createdAt.getTime()) / 36e5);
      return {
        byStatus: byStatus.map(s => ({ status: s.status, count: s._count })),
        avgResolutionHours: hours.length ? +(hours.reduce((a, b) => a + b, 0) / hours.length).toFixed(1) : null,
        warrantyTickets,
      };
    }),
  );
}));

export default r;
