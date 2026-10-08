import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { useDispatch, useSelector } from "react-redux";

export type Role = "CUSTOMER" | "MANAGER" | "TECHNICIAN";
export type User = { id: string; name: string; role: Role };
export type Ticket = {
  id: string; title: string; description: string; category: string; priority: number; status: string;
  address: string; lat: number; lng: number; images: string[]; underWarranty: boolean; preferredStart?: string | null;
  aiLabel?: string | null; aiConfidence?: number | null; aiImage?: { blurry: boolean; dark: boolean } | null;
  diagnosis?: string | null; resolution?: string | null;
  customer?: { name: string }; technician?: { user: { name: string } } | null; appointment?: { startsAt: string } | null;
  events?: { id: string; fromStatus?: string | null; toStatus: string; at: string }[];
};

/** Thin fetch wrapper: adds the JWT, sends JSON or multipart, and turns API errors into Error messages. */
export async function api<T = any>(path: string, opts: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const token = JSON.parse(localStorage.getItem("session") ?? "{}").token;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.json || opts.form ? "POST" : "GET"),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.json ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.form ?? (opts.json ? JSON.stringify(opts.json) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Request failed");
  return data;
}

export const login = createAsyncThunk("auth/login", (body: { email: string; password: string }) =>
  api<{ token: string; user: User }>("/auth/login", { json: body }),
);
export const fetchTickets = createAsyncThunk("tickets/fetch", () => api<Ticket[]>("/tickets"));

const saved = localStorage.getItem("session");
const authSlice = createSlice({
  name: "auth",
  initialState: (saved ? JSON.parse(saved) : { token: null, user: null }) as { token: string | null; user: User | null },
  reducers: { logout: () => ({ token: null, user: null }) },
  extraReducers: b => {
    b.addCase(login.fulfilled, (_s, a) => a.payload);
  },
});
export const { logout } = authSlice.actions;

const ticketsSlice = createSlice({
  name: "tickets",
  initialState: { items: [] as Ticket[] },
  reducers: {},
  extraReducers: b => {
    b.addCase(fetchTickets.fulfilled, (s, a) => { s.items = a.payload; });
    b.addCase(logout, s => { s.items = []; });
  },
});

// Short-lived realtime messages shown as toasts.
const feedSlice = createSlice({
  name: "feed",
  initialState: [] as { id: number; text: string }[],
  reducers: {
    push: (s, a: PayloadAction<{ id: number; text: string }>) => [...s, a.payload].slice(-3),
    drop: (s, a: PayloadAction<number>) => s.filter(m => m.id !== a.payload),
  },
  extraReducers: b => {
    b.addCase(logout, () => []);
  },
});
export const { push, drop } = feedSlice.actions;

export const store = configureStore({
  reducer: { auth: authSlice.reducer, tickets: ticketsSlice.reducer, feed: feedSlice.reducer },
});
store.subscribe(() => localStorage.setItem("session", JSON.stringify(store.getState().auth)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
