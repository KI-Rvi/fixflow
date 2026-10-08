import { prisma } from "./lib";

export const SLOT_MIN = 120;
const START_HOURS = [9, 11, 13, 15];

export type Suggestion = { technicianId: string; name: string; km: number; openJobs: number; score: number; nextSlot: string; matchesPreferred: boolean };

/** First free 2-hour weekday slot for a technician within the next two weeks. */
export async function firstFreeSlot(technicianId: string, after = new Date()): Promise<Date | null> {
  const busy = await prisma.appointment.findMany({ where: { technicianId, endsAt: { gt: after } } });
  const timeOff = await prisma.timeOff.findMany({ where: { technicianId, endsAt: { gt: after } } });
  const shifts = await prisma.shift.findMany({ where: { technicianId } });
  for (let day = 0; day < 14; day++) {
    for (const hour of START_HOURS) {
      const start = new Date(after);
      start.setDate(start.getDate() + day);
      start.setHours(hour, 0, 0, 0);
      if (start <= after || [0, 6].includes(start.getDay())) continue;
      const end = new Date(start.getTime() + SLOT_MIN * 60_000);
      const shift = shifts.find(s => s.dayOfWeek === start.getDay() && hour * 60 >= s.startMinute && hour * 60 + SLOT_MIN <= s.endMinute);
      if (!shift) continue;
      const leaves = timeOff.some(o => o.startsAt < end && o.endsAt > start);
      if (leaves) continue;
      if (!busy.some(a => a.startsAt < end && a.endsAt > start)) return start;
    }
  }
  return null;
}

/** Skill is a hard filter; score = 60 x proximity + 40 x spare capacity. */
export async function rankTechnicians(t: { category: string; lat: number; lng: number; preferredStart?: Date | null }): Promise<Suggestion[]> {
  // PostGIS computes the geodesic distance in the database.
  const near = await prisma.$queryRaw<{ id: string; km: number }[]>`
    SELECT id,
      ST_Distance(
        ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${t.lng}::float8, ${t.lat}::float8), 4326)::geography
      ) / 1000 AS km
    FROM "Technician"
    WHERE active AND ${t.category} = ANY(skills)`;
  if (!near.length) return [];

  const ids = near.map(n => n.id);
  const [techs, open] = await Promise.all([
    prisma.technician.findMany({ where: { id: { in: ids } }, include: { user: { select: { name: true } } } }),
    prisma.ticket.groupBy({
      by: ["technicianId"],
      where: { technicianId: { in: ids }, status: { in: ["SCHEDULED", "IN_PROGRESS", "AWAITING_PARTS"] } },
      _count: true,
    }),
  ]);

  const ranked: Suggestion[] = [];
  for (const tech of techs) {
    const km = near.find(n => n.id === tech.id)!.km;
    const openJobs = open.find(o => o.technicianId === tech.id)?._count ?? 0;
    const wanted = t.preferredStart ?? null;
    const slot = wanted && (await isFree(tech.id, wanted)) ? wanted : await firstFreeSlot(tech.id);
    if (!slot) continue;
    const proximity = 1 - Math.min(km, 50) / 50;
    const capacity = Math.max(0, 1 - openJobs / tech.maxOpenJobs);
    ranked.push({
      technicianId: tech.id,
      name: tech.user.name,
      km: +km.toFixed(1),
      openJobs,
      score: Math.round(60 * proximity + 40 * capacity),
      nextSlot: slot.toISOString(),
      matchesPreferred: !!wanted && slot.getTime() === wanted.getTime(),
    });
  }
  return ranked.sort((a, b) => Number(b.matchesPreferred) - Number(a.matchesPreferred) || b.score - a.score);
}
async function isFree(technicianId: string, start: Date) {
  const end = new Date(start.getTime() + SLOT_MIN * 60_000);
  const shift = await prisma.shift.findFirst({
    where: { technicianId, dayOfWeek: start.getDay(), startMinute: { lte: start.getHours() * 60 + start.getMinutes() }, endMinute: { gte: end.getHours() * 60 + end.getMinutes() } },
  });
  if (!shift) return false;
  const leave = await prisma.timeOff.findFirst({ where: { technicianId, startsAt: { lt: end }, endsAt: { gt: start } } });
  if (leave) return false;
  return !(await prisma.appointment.findFirst({ where: { technicianId, startsAt: { lt: end }, endsAt: { gt: start } } }));
}

/** A time is listed if at least one qualified technician inside the service radius is free then. */
export async function availableSlots(
  t: { category: string; lat: number; lng: number },
  radiusKm = 50,
  days = 7,
): Promise<{ startsAt: string; freeTechnicians: number }[]> {
  const techs = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Technician"
    WHERE active AND ${t.category} = ANY(skills)
      AND ST_DWithin(
        ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${t.lng}::float8, ${t.lat}::float8), 4326)::geography,
        ${radiusKm * 1000}::float8)`;
  if (!techs.length) return [];

  const from = new Date();
  const busy = await prisma.appointment.findMany({
    where: { technicianId: { in: techs.map(x => x.id) }, endsAt: { gt: from } },
  });

  const slots: { startsAt: string; freeTechnicians: number }[] = [];
  for (let day = 0; day < days; day++) {
    for (const hour of START_HOURS) {
      const start = new Date(from);
      start.setDate(start.getDate() + day);
      start.setHours(hour, 0, 0, 0);
      if (start <= from || [0, 6].includes(start.getDay())) continue;
      const end = new Date(start.getTime() + SLOT_MIN * 60_000);
      const free = techs.filter(x => !busy.some(a => a.technicianId === x.id && a.startsAt < end && a.endsAt > start)).length;
      if (free) slots.push({ startsAt: start.toISOString(), freeTechnicians: free });
    }
  }
  return slots;
}