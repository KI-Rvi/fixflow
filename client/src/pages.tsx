import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, fetchTickets, login, useAppDispatch, useAppSelector, type Ticket } from "./store";

// Status colour is the one visual code across the app: the stripe on a job, the bars in the chart.
const STATUS_COLOR: Record<string, string> = {
  NEW: "#d64545", SCHEDULED: "#5e7285", IN_PROGRESS: "#f5b800",
  AWAITING_PARTS: "#e8772e", COMPLETED: "#1f9d55", CANCELLED: "#9aa7b1",
};
const PRIORITY = ["", "low", "normal", "high", "urgent"];
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace("_", " ");
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

function MapPreview({ lat, lng, address }: { lat: number; lng: number; address: string }) {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  const url = token ? `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${lng},${lat},12,0/900x220?access_token=${token}` : null;
  return (
    <div className="mt-2 overflow-hidden rounded border border-line bg-soft">
      {url ? <img src={url} alt={address} className="h-28 w-full object-cover" /> : <p className="p-3 text-sm text-steel"><a className="underline" href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">Open in maps</a></p>}
    </div>
  );
}

function TicketRow({ t, staff, children }: { t: Ticket; staff?: boolean; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<Ticket | null>(null);

  const toggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    try {
      const d = await api<Ticket>(`/tickets/${t.id}`);
      setDetail(d);
      setExpanded(true);
    } catch {
      setExpanded(true);
    }
  };

  return (
    <li className="border-b border-l-[6px] border-line bg-white p-4" style={{ borderLeftColor: STATUS_COLOR[t.status] }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 className="font-bold">{t.title}</h3>
        <p className="text-sm font-semibold">{label(t.status)}, {PRIORITY[t.priority]} priority</p>
      </div>
      <p className="mt-1 text-sm">{t.description}</p>
      <p className="mt-1 text-sm text-steel">
        <a className="underline" href={`https://www.google.com/maps?q=${t.lat},${t.lng}`} target="_blank" rel="noreferrer">{t.address}</a>
        {staff && t.customer ? `, ${t.customer.name}` : ""}
      </p>
      {t.technician && t.appointment && <p className="mt-1 text-sm">{t.technician.user.name} visits {when(t.appointment.startsAt)}</p>}
      {t.preferredStart && t.status === "NEW" && <p className="mt-1 text-sm">Requested time: {when(t.preferredStart)}</p>}
      {t.underWarranty && <p className="mt-1 text-sm text-ok">Covered by warranty</p>}
      {t.aiLabel && (
        <p className="mt-1 text-sm text-steel">
          Automatic triage: {label(t.aiLabel)}, {Math.round((t.aiConfidence ?? 0) * 100)}% confidence.
          {t.aiImage?.blurry ? " Photo is blurry." : ""}{t.aiImage?.dark ? " Photo is too dark." : ""}
        </p>
      )}
      {t.images.length > 0 && (
        <div className="mt-2 flex gap-2">
          {t.images.map(src => <img key={src} src={src} alt="Customer upload" className="h-16 w-16 object-cover" />)}
        </div>
      )}
      <MapPreview lat={t.lat} lng={t.lng} address={t.address} />
      <button type="button" className="mt-2 text-sm underline" onClick={toggle}>{expanded ? "Hide timeline" : "View timeline"}</button>
      {expanded && detail && (
        <div className="mt-3 rounded border border-line bg-soft p-3 text-sm">
          <p className="mb-2 font-semibold">Repair timeline</p>
          <ul className="space-y-2">
            {(detail.events ?? []).map(e => (
              <li key={e.id} className="border-l border-line pl-3">
                <span className="font-medium">{e.toStatus}</span> {e.fromStatus ? `from ${label(e.fromStatus)}` : "opened"} — {when(e.at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {children}
    </li>
  );
}

function Notifications() {
  const [items, setItems] = useState<{ id: string; text: string; at: string; read: boolean }[]>([]);
  useEffect(() => {
    api("/notifications").then(setItems).catch(() => setItems([]));
  }, []);

  return (
    <section className="space-y-2 bg-white p-4">
      <h2 className="text-lg font-bold">Notifications</h2>
      {items.length === 0 ? <p className="text-steel">No notifications yet.</p> : (
        <ul className="space-y-2 text-sm">
          {items.map(n => <li key={n.id} className="border-l-4 border-volt bg-soft p-2">{n.text} <span className="text-steel">{when(n.at)}</span></li>)}
        </ul>
      )}
    </section>
  );
}

export function Login() {
  const dispatch = useAppDispatch();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [err, setErr] = useState("");

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      if (mode === "register") await api("/auth/register", { json: f });
      await dispatch(login({ email: f.email, password: f.password })).unwrap();
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center p-5">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 border-t-8 border-volt bg-white p-6">
        <h1 className="text-2xl font-extrabold">FixFlow</h1>
        <p className="text-sm text-steel">Book repairs, dispatch technicians, and follow every job.</p>
        {mode === "register" && <input name="name" required minLength={2} placeholder="Full name" className="field" />}
        <input name="email" type="email" required placeholder="Email" className="field" />
        <input name="password" type="password" required minLength={8} placeholder="Password (8 or more characters)" className="field" />
        {err && <p role="alert" className="text-sm text-fault">{err}</p>}
        <button className="btn btn-volt w-full">{mode === "login" ? "Log in" : "Create account"}</button>
        <button type="button" className="text-sm underline" onClick={() => { setErr(""); setMode(mode === "login" ? "register" : "login"); }}>
          {mode === "login" ? "New customer? Create an account" : "Have an account? Log in"}
        </button>
        <p className="text-xs text-steel">Demo logins: customer@fixflow.dev, manager@fixflow.dev, ava@fixflow.dev (password123)</p>
      </form>
    </div>
  );
}

export function Customer() {
  const dispatch = useAppDispatch();
  const tickets = useAppSelector(s => s.tickets.items);
  const [equipment, setEquipment] = useState<{ id: string; brand: string; modelName: string; category: string; warrantyUntil: string }[]>([]);
  const [equipmentHistory, setEquipmentHistory] = useState<any[] | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [category, setCategory] = useState("");
  const [slots, setSlots] = useState<{ startsAt: string; freeTechnicians: number }[]>([]);
  const [msg, setMsg] = useState("");
  const [equipmentForm, setEquipmentForm] = useState({ category: "", brand: "", modelName: "", serial: "", purchasedAt: "", warrantyMonths: "12" });

  useEffect(() => {
    api("/equipment").then(setEquipment).catch(() => {});
  }, []);

  useEffect(() => {
    if (!coords || !category) {
      setSlots([]);
      return;
    }
    api(`/slots?category=${category}&lat=${coords.lat}&lng=${coords.lng}`)
      .then(setSlots)
      .catch(() => setSlots([]));
  }, [coords, category]);

  const reloadEquipment = () => api("/equipment").then(setEquipment).catch(() => {});

  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      p => setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setMsg("Location is blocked. Allow it in your browser so we can match a nearby technician."),
    );

  const submitEquipment = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await api("/equipment", {
        json: {
          ...equipmentForm,
          warrantyMonths: Number(equipmentForm.warrantyMonths),
          purchasedAt: equipmentForm.purchasedAt || new Date().toISOString(),
        },
      });
      setEquipmentForm({ category: "", brand: "", modelName: "", serial: "", purchasedAt: "", warrantyMonths: "12" });
      reloadEquipment();
      setMsg("Equipment added.");
    } catch (x) {
      setMsg((x as Error).message);
    }
  };

  const showHistory = async (id: string) => {
    try {
      const next = await api<any>(`/equipment/${id}/history`);
      setEquipmentHistory(next.tickets ?? []);
    } catch {
      setEquipmentHistory([]);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!coords) return setMsg("Select “Use my location” so we can match a nearby technician.");
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    form.set("lat", String(coords.lat));
    form.set("lng", String(coords.lng));
    for (const k of ["equipmentId", "category", "preferredStart"]) if (!form.get(k)) form.delete(k);
    try {
      await api("/tickets", { form });
      formEl.reset();
      setCategory("");
      setSlots([]);
      setMsg("Request sent. We will notify you as soon as a technician is scheduled.");
      dispatch(fetchTickets());
    } catch (x) {
      setMsg((x as Error).message);
    }
  };

  const cancel = (id: string) =>
    api(`/tickets/${id}/cancel`, { method: "POST" }).then(() => dispatch(fetchTickets())).catch(x => setMsg(x.message));

  return (
    <div className="grid gap-6 md:grid-cols-[22rem_1fr]">
      <div className="space-y-6 self-start">
        <form onSubmit={submit} className="space-y-3 bg-white p-4">
          <h2 className="text-lg font-bold">Request a repair</h2>
          <input name="title" required minLength={3} placeholder="What is broken?" className="field" />
          <textarea name="description" required minLength={10} rows={4} placeholder="When it started, any noises, smells, or error codes" className="field" />
          <input name="address" required placeholder="Service address" className="field" />
          <select name="equipmentId" className="field">
            <option value="">Equipment not listed</option>
            {equipment.map(q => <option key={q.id} value={q.id}>{q.brand} {q.modelName}</option>)}
          </select>
          <select name="category" className="field" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Not sure (we will work it out)</option>
            <option value="HEATING_AND_COOLING">Heating and cooling</option>
            <option value="ELECTRICAL">Electrical</option>
            <option value="APPLIANCE">Appliance</option>
          </select>
          <select name="preferredStart" className="field" disabled={!category || !coords || slots.length === 0}>
            <option value="">{!category ? "Pick a category to see times" : !coords ? "Share your location to see times" : slots.length ? "Choose a time (optional)" : "No free times nearby"}</option>
            {slots.map(s => <option key={s.startsAt} value={s.startsAt}>{when(s.startsAt)}</option>)}
          </select>
          <input name="images" type="file" accept="image/*" multiple className="field" />
          <button type="button" className="btn" onClick={locate}>{coords ? "Location saved" : "Use my location"}</button>
          {msg && <p role="status" className="text-sm">{msg}</p>}
          <button className="btn btn-volt w-full">Send request</button>
        </form>

        <section className="space-y-3 bg-white p-4">
          <h2 className="text-lg font-bold">My equipment</h2>
          <form onSubmit={submitEquipment} className="grid gap-2">
            <input value={equipmentForm.category} onChange={e => setEquipmentForm({ ...equipmentForm, category: e.target.value })} placeholder="Category" className="field" />
            <input value={equipmentForm.brand} onChange={e => setEquipmentForm({ ...equipmentForm, brand: e.target.value })} placeholder="Brand" className="field" />
            <input value={equipmentForm.modelName} onChange={e => setEquipmentForm({ ...equipmentForm, modelName: e.target.value })} placeholder="Model" className="field" />
            <input value={equipmentForm.serial} onChange={e => setEquipmentForm({ ...equipmentForm, serial: e.target.value })} placeholder="Serial number" className="field" />
            <input type="date" value={equipmentForm.purchasedAt} onChange={e => setEquipmentForm({ ...equipmentForm, purchasedAt: e.target.value })} className="field" />
            <input type="number" min={0} max={120} value={equipmentForm.warrantyMonths} onChange={e => setEquipmentForm({ ...equipmentForm, warrantyMonths: e.target.value })} placeholder="Warranty months" className="field" />
            <button className="btn btn-volt">Add equipment</button>
          </form>
          <ul className="space-y-2 text-sm">
            {equipment.length === 0 ? <li className="text-steel">No equipment yet.</li> : equipment.map(item => (
              <li key={item.id} className="rounded border border-line p-2">
                <div className="flex items-center justify-between gap-3"><span className="font-medium">{item.brand} {item.modelName}</span><span className="text-steel">{item.category}</span></div>
                <div className="mt-1 text-steel">Warranty ends {when(item.warrantyUntil)}</div>
                <button type="button" className="mt-2 text-sm underline" onClick={() => showHistory(item.id)}>Service history</button>
              </li>
            ))}
          </ul>
          {equipmentHistory && equipmentHistory.length > 0 && (
            <div className="rounded border border-line bg-soft p-3 text-sm">
              <p className="mb-2 font-semibold">Service history</p>
              <ul className="space-y-2">
                {equipmentHistory.map((entry: any) => (
                  <li key={entry.id} className="border-l border-line pl-3">
                    <span className="font-medium">{entry.status}</span> — {when(entry.createdAt)}
                    {entry.parts?.length ? `, parts: ${entry.parts.map((p: any) => `${p.qty}x ${p.part?.name ?? "part"}`).join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <section>
        <Notifications />
        <h2 className="mb-2 mt-6 text-lg font-bold">Your requests</h2>
        {tickets.length === 0 ? (
          <p className="text-steel">No requests yet. Describe a problem and we will match a technician.</p>
        ) : (
          <ul>
            {tickets.map(t => (
              <TicketRow key={t.id} t={t}>
                {["NEW", "SCHEDULED"].includes(t.status) && (
                  <button className="mt-2 text-sm underline" onClick={() => cancel(t.id)}>Cancel request</button>
                )}
              </TicketRow>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Suggestion = { technicianId: string; name: string; km: number; openJobs: number; score: number; nextSlot: string; matchesPreferred: boolean };
type Stats = { byStatus: { status: string; count: number }[]; avgResolutionHours: number | null; warrantyTickets: number };

export function Dispatch() {
  const dispatch = useAppDispatch();
  const tickets = useAppSelector(s => s.tickets.items);
  const [stats, setStats] = useState<Stats | null>(null);
  const [picked, setPicked] = useState<Ticket | null>(null);
  const [options, setOptions] = useState<Suggestion[] | null>(null);
  const [err, setErr] = useState("");
  const [techForm, setTechForm] = useState({ email: "", name: "", password: "", skills: "", lat: "", lng: "", maxOpenJobs: "5" });
  const [partForm, setPartForm] = useState({ sku: "", name: "", stock: "0", unitCost: "0" });

  useEffect(() => {
    api("/analytics/summary").then(setStats).catch(() => {});
  }, [tickets]);

  const open = (t: Ticket) => {
    setPicked(t);
    setOptions(null);
    setErr("");
    api<Suggestion[]>(`/tickets/${t.id}/suggestions`).then(setOptions).catch(x => setErr(x.message));
  };

  const assign = async (s: Suggestion) => {
    try {
      await api(`/tickets/${picked!.id}/assign`, { json: { technicianId: s.technicianId, startsAt: s.nextSlot } });
      setPicked(null);
      setOptions(null);
      dispatch(fetchTickets());
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  const addTechnician = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await api("/technicians", { json: {
        ...techForm,
        skills: techForm.skills.split(",").map(s => s.trim()).filter(Boolean),
        lat: Number(techForm.lat),
        lng: Number(techForm.lng),
        maxOpenJobs: Number(techForm.maxOpenJobs),
      } });
      setTechForm({ email: "", name: "", password: "", skills: "", lat: "", lng: "", maxOpenJobs: "5" });
      setErr("");
      dispatch(fetchTickets());
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  const restockPart = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await api("/parts", { json: { ...partForm, stock: Number(partForm.stock), unitCost: Number(partForm.unitCost) } });
      setPartForm({ sku: "", name: "", stock: "0", unitCost: "0" });
      setErr("");
      dispatch(fetchTickets());
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  const queue = tickets.filter(t => t.status === "NEW");

  return (
    <div className="space-y-6">
      <Notifications />

      {stats && (
        <section className="grid gap-4 bg-white p-4 md:grid-cols-[1fr_16rem]">
          <div className="h-44" role="img" aria-label="Requests by status">
            <ResponsiveContainer>
              <BarChart data={stats.byStatus.map(s => ({ ...s, name: label(s.status) }))} layout="vertical">
                <XAxis type="number" allowDecimals={false} hide />
                <YAxis type="category" dataKey="name" width={110} tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="count" radius={2}>
                  {stats.byStatus.map(s => <Cell key={s.status} fill={STATUS_COLOR[s.status]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-steel">Average time to complete</dt>
              <dd className="text-xl font-extrabold">{stats.avgResolutionHours === null ? "No completed jobs yet" : `${stats.avgResolutionHours} hours`}</dd>
            </div>
            <div>
              <dt className="text-steel">Requests covered by warranty</dt>
              <dd className="text-xl font-extrabold">{stats.warrantyTickets}</dd>
            </div>
          </dl>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-6">
          <section className="space-y-3 bg-white p-4">
            <h2 className="text-lg font-bold">Add technician</h2>
            <form onSubmit={addTechnician} className="grid gap-2">
              <input value={techForm.name} onChange={e => setTechForm({ ...techForm, name: e.target.value })} placeholder="Name" className="field" />
              <input value={techForm.email} onChange={e => setTechForm({ ...techForm, email: e.target.value })} placeholder="Email" className="field" />
              <input type="password" value={techForm.password} onChange={e => setTechForm({ ...techForm, password: e.target.value })} placeholder="Password" className="field" />
              <input value={techForm.skills} onChange={e => setTechForm({ ...techForm, skills: e.target.value })} placeholder="Skills, comma separated" className="field" />
              <div className="grid gap-2 sm:grid-cols-2">
                <input value={techForm.lat} onChange={e => setTechForm({ ...techForm, lat: e.target.value })} placeholder="Latitude" className="field" />
                <input value={techForm.lng} onChange={e => setTechForm({ ...techForm, lng: e.target.value })} placeholder="Longitude" className="field" />
              </div>
              <input type="number" min={1} max={20} value={techForm.maxOpenJobs} onChange={e => setTechForm({ ...techForm, maxOpenJobs: e.target.value })} placeholder="Max open jobs" className="field" />
              <button className="btn btn-volt">Create technician</button>
            </form>
          </section>

          <section className="space-y-3 bg-white p-4">
            <h2 className="text-lg font-bold">Restock parts</h2>
            <form onSubmit={restockPart} className="grid gap-2">
              <input value={partForm.sku} onChange={e => setPartForm({ ...partForm, sku: e.target.value })} placeholder="SKU" className="field" />
              <input value={partForm.name} onChange={e => setPartForm({ ...partForm, name: e.target.value })} placeholder="Part name" className="field" />
              <div className="grid gap-2 sm:grid-cols-2">
                <input type="number" min={0} value={partForm.stock} onChange={e => setPartForm({ ...partForm, stock: e.target.value })} placeholder="Stock" className="field" />
                <input type="number" min={0} step="0.01" value={partForm.unitCost} onChange={e => setPartForm({ ...partForm, unitCost: e.target.value })} placeholder="Unit cost" className="field" />
              </div>
              <button className="btn btn-volt">Add to inventory</button>
            </form>
          </section>
        </div>

        <section>
          <h2 className="mb-2 text-lg font-bold">Waiting for a technician ({queue.length})</h2>
          {queue.length === 0 ? (
            <p className="text-steel">Nothing waiting. New requests appear here as customers send them.</p>
          ) : (
            <ul>
              {queue.map(t => (
                <TicketRow key={t.id} t={t} staff>
                  <button className="btn mt-2" onClick={() => open(t)}>Find technician</button>
                </TicketRow>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <section>
          <h2 className="mb-2 text-lg font-bold">Technician matches</h2>
          {!picked && <p className="text-steel">Choose a request to rank technicians by skill, distance, and workload.</p>}
          {err && <p role="alert" className="mb-2 text-fault">{err}</p>}
          {picked && options?.length === 0 && <p className="text-steel">No active technician has the {label(picked.category)} skill and a free slot.</p>}
          <ul>
            {options?.map(s => (
              <li key={s.technicianId} className="flex items-center justify-between gap-3 border-b border-line bg-white p-4">
                <div>
                  <p className="font-bold">{s.name}</p>
                  <p className="text-sm text-steel">{s.km.toFixed(1)} km away, {s.openJobs} open jobs, {s.matchesPreferred ? "preferred" : "first free"} slot {when(s.nextSlot)}</p>
                </div>
                <button className="btn btn-volt" onClick={() => assign(s)}>Assign and book</button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-lg font-bold">Scheduled and finished work</h2>
          <ul>{tickets.filter(t => t.status !== "NEW").map(t => <TicketRow key={t.id} t={t} staff />)}</ul>
        </section>
      </div>
    </div>
  );
}

// What a technician may do next from each state (mirrors the server's lifecycle rules).
const NEXT: Record<string, string[]> = {
  SCHEDULED: ["IN_PROGRESS"],
  IN_PROGRESS: ["AWAITING_PARTS", "COMPLETED"],
  AWAITING_PARTS: ["IN_PROGRESS"],
};

export function Technician() {
  const dispatch = useAppDispatch();
  const tickets = useAppSelector(s => s.tickets.items);
  const [parts, setParts] = useState<{ id: string; name: string; stock: number }[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    api("/parts").then(setParts).catch(() => {});
  }, []);

  const save = async (t: Ticket, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const partId = String(f.get("partId") ?? "");
    try {
      await api(`/tickets/${t.id}/progress`, {
        method: "PATCH",
        json: {
          status: f.get("status"),
          diagnosis: f.get("diagnosis") || undefined,
          resolution: f.get("resolution") || undefined,
          parts: partId ? [{ partId, qty: Number(f.get("qty") || 1) }] : [],
        },
      });
      setErr("");
      dispatch(fetchTickets());
      api("/parts").then(setParts).catch(() => {});
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  const jobs = tickets.filter(t => NEXT[t.status]);

  return (
    <section>
      <h2 className="mb-2 text-lg font-bold">Your jobs ({jobs.length})</h2>
      {err && <p role="alert" className="mb-2 text-fault">{err}</p>}
      {jobs.length === 0 ? (
        <p className="text-steel">No jobs assigned. Scheduled visits show up here the moment a manager books them.</p>
      ) : (
        <ul>
          {jobs.map(t => (
            <TicketRow key={t.id} t={t} staff>
              <form onSubmit={e => save(t, e)} className="mt-3 grid gap-2 md:grid-cols-2">
                <select name="status" className="field" aria-label="Status">
                  {[t.status, ...NEXT[t.status]].map(s => (
                    <option key={s} value={s}>{s === t.status ? `${label(s)} (no change)` : label(s)}</option>
                  ))}
                </select>
                <input name="diagnosis" defaultValue={t.diagnosis ?? ""} placeholder="Diagnosis" className="field" />
                <input name="resolution" defaultValue={t.resolution ?? ""} placeholder="What was done (required to complete)" className="field md:col-span-2" />
                <select name="partId" className="field" aria-label="Part used">
                  <option value="">No part used</option>
                  {parts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.stock} in stock)</option>)}
                </select>
                <input name="qty" type="number" min={1} defaultValue={1} className="field" aria-label="Part quantity" />
                <button className="btn btn-volt md:col-span-2">Save progress</button>
              </form>
            </TicketRow>
          ))}
        </ul>
      )}
    </section>
  );
}
