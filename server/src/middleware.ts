import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { ZodSchema } from "zod";

export type AuthUser = { id: string; role: "CUSTOMER" | "MANAGER" | "TECHNICIAN" };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
export const sign = (u: AuthUser) => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "8h" });
export const verify = (token: string) => jwt.verify(token, SECRET) as unknown as AuthUser;

export function auth(req: Request, res: Response, next: NextFunction) {
  try {
    req.user = verify(req.headers.authorization?.replace("Bearer ", "") ?? "");
    next();
  } catch {
    res.status(401).json({ error: "Please log in again" });
  }
}

export const requireRole =
  (...roles: AuthUser["role"][]) =>
  (req: Request, res: Response, next: NextFunction) =>
    roles.includes(req.user!.role) ? next() : res.status(403).json({ error: "Your role cannot do this" });

export const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  req.body = parsed.data;
  next();
};
