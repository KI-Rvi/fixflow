import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const HOME = { lat: 40.73, lng: -73.99 }; // set this to your city; technicians are seeded nearby
const DAY = 86_400_000;

async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);
  const user = (email: string, name: string, role: Role) =>
    prisma.user.upsert({ where: { email }, update: {}, create: { email, name, role, passwordHash } });

  await user("manager@fixflow.dev", "Mia Torres", "MANAGER");
  const customer = await user("customer@fixflow.dev", "Dana Lee", "CUSTOMER");

  const techs = [
    ["ava@fixflow.dev", "Ava Hart", ["HVAC", "ELECTRICAL", "GENERAL"], 0.02, 0.01],
    ["ben@fixflow.dev", "Ben Ortiz", ["APPLIANCE", "GENERAL"], -0.04, -0.03],
  ] as const;
  for (const [email, name, skills, dLat, dLng] of techs) {
    const u = await user(email, name, "TECHNICIAN");
    await prisma.technician.upsert({
      where: { userId: u.id },
      update: {},
      create: { userId: u.id, skills: [...skills], lat: HOME.lat + dLat, lng: HOME.lng + dLng },
    });
  }

  await prisma.equipment.upsert({
    where: { serial: "LG-WM-001" },
    update: {},
    create: {
      ownerId: customer.id, category: "APPLIANCE", brand: "LG", modelName: "WM3600", serial: "LG-WM-001",
      purchasedAt: new Date(Date.now() - 200 * DAY), warrantyUntil: new Date(Date.now() + 165 * DAY),
    },
  });

  for (const [sku, name, stock, unitCost] of [
    ["CMP-01", "Compressor relay", 25, 18],
    ["BLT-02", "Drive belt", 40, 9],
    ["PMP-03", "Drain pump", 12, 32],
  ] as const) {
    await prisma.part.upsert({ where: { sku }, update: {}, create: { sku, name, stock, unitCost } });
  }
}

main().finally(() => prisma.$disconnect());
