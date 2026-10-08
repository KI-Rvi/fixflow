import "dotenv/config";
import http from "http";
import path from "path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Server } from "socket.io";
import { setIo } from "./lib";
import { verify } from "./middleware";
import routes from "./routes";

const origin = process.env.CLIENT_URL ?? "http://localhost:5173";
const app = express();
app.use(cors({ origin }));
app.use(express.json());
app.use("/uploads", express.static(path.resolve("uploads")));
app.use("/api", routes);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? (err.name === "MulterError" ? 400 : ["P2002", "P2034"].includes(err.code) ? 409 : 500);
  if (status === 500) console.error(err);
  const message =
    err.code === "P2002" ? "That already exists"
    : err.code === "P2034" ? "Someone changed this at the same time, please retry"
    : err.message;
  res.status(status).json({ error: status === 500 ? "Something went wrong on our side" : message });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin } });

// Sockets use the same JWT as the REST API and join per-user and per-role rooms.
io.use((socket, next) => {
  try {
    socket.data.user = verify(String(socket.handshake.auth.token ?? ""));
    next();
  } catch {
    next(new Error("unauthorized"));
  }
});
io.on("connection", socket => {
  const { id, role } = socket.data.user;
  socket.join([`user:${id}`, `role:${role}`]);
});
setIo(io);

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => console.log(`FixFlow API listening on :${port}`));
