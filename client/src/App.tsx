import { useEffect } from "react";
import { io } from "socket.io-client";
import { drop, fetchTickets, logout, push, useAppDispatch, useAppSelector } from "./store";
import { Customer, Dispatch, Login, Technician } from "./pages";

// Role-based UI: the server enforces access, the client just shows each role its own workspace.
const HOME = { CUSTOMER: <Customer />, MANAGER: <Dispatch />, TECHNICIAN: <Technician /> };

export default function App() {
  const { token, user } = useAppSelector(s => s.auth);
  const feed = useAppSelector(s => s.feed);
  const dispatch = useAppDispatch();

  // One socket per login. Any ticket change refetches the list so every screen stays current.
  useEffect(() => {
    if (!token) return;
    dispatch(fetchTickets());
    const socket = io({ auth: { token } });
    socket.on("ticket:updated", (e: { text: string }) => {
      const id = Date.now();
      dispatch(push({ id, text: e.text }));
      setTimeout(() => dispatch(drop(id)), 6000);
      dispatch(fetchTickets());
    });
    return () => {
      socket.disconnect();
    };
  }, [token, dispatch]);

  if (!user) return <Login />;
  return (
    <>
      <header className="flex items-center justify-between bg-ink px-5 py-3 text-white">
        <span className="flex items-center gap-2 text-lg font-extrabold">
          <span className="inline-block h-4 w-4 bg-volt" aria-hidden />
          FixFlow
        </span>
        <span className="flex items-center gap-4 text-sm">
          {user.name} ({user.role.toLowerCase()})
          <button className="underline" onClick={() => dispatch(logout())}>Log out</button>
        </span>
      </header>
      <main className="mx-auto max-w-6xl p-5">{HOME[user.role]}</main>
      <div aria-live="polite" className="fixed bottom-4 right-4 flex max-w-xs flex-col gap-2">
        {feed.map(m => (
          <p key={m.id} className="border-l-4 border-volt bg-ink px-3 py-2 text-sm text-white">{m.text}</p>
        ))}
      </div>
    </>
  );
}
