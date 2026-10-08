import { readFile } from "fs/promises";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import type { Server } from "socket.io";

export const prisma = new PrismaClient();

export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
redis.on("error", () => {}); // the cache is optional: the API keeps working without Redis

let io: Server | undefined;
export const setIo = (s: Server) => {
  io = s;
};

export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {}
  const value = await load();
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {}
  return value;
}

/** Store notifications, refresh the dashboard cache, and push the change to everyone involved. */
export async function publishTicket(ticketId: string, text: string) {
  const t = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { technician: true } });
  if (!t) return;
  const users = [t.customerId, t.technician?.userId].filter((u): u is string => !!u);
  await prisma.notification.createMany({ data: users.map(userId => ({ userId, text })) });
  redis.del("analytics:summary").catch(() => {});
  io?.to([...users.map(u => `user:${u}`), "role:MANAGER"]).emit("ticket:updated", { id: t.id, status: t.status, text });
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token || !address.trim()) return null;
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${token}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json() as { features?: Array<{ center?: [number, number] }> };
    const center = data.features?.[0]?.center;
    if (!center) return null;
    return { lat: center[1], lng: center[0] };
  } catch {
    return null;
  }
}

type AiResult = {
  category: string;
  confidence: number;
  priority: number;
  image?: { blurry: boolean; dark: boolean; sharpness: number; rust_ratio: number } | null;
};

/** Ask the AI service to classify the problem and check the first photo. Returns null if it is down. */
export async function triage(text: string, photo?: { path: string; originalname: string }): Promise<AiResult | null> {
  try {
    const form = new FormData();
    form.append("text", text);
    if (photo) form.append("image", new Blob([await readFile(photo.path)]), photo.originalname);
    const res = await fetch(`${process.env.AI_URL ?? "http://localhost:8000"}/triage`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? ((await res.json()) as AiResult) : null;
  } catch {
    return null;
  }
}
