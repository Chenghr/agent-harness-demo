"use client";
import { useEffect, useState } from "react";
import { CompanionWidget } from "../components/companion";
export default function PetPage() {
  const [sid, setSid] = useState<string | null>(null),
    [sessions, setSessions] = useState<{ id: string; title: string }[]>([]),
    [error, setError] = useState(""),
    [follow, setFollow] = useState(true);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("native")) document.body.classList.add("native-pet");
    let active = true;
    const update = () =>
      Promise.all(
        ["/api/sessions", "/api/companion/focus"].map((url) =>
          fetch(url).then((r) => {
            if (!r.ok) throw new Error("服务连接失败");
            return r.json();
          }),
        ),
      )
        .then(([items, focus]) => {
          if (!active) return;
          const list = items as { id: string; title: string }[];
          setSessions(list);
          setError("");
          const focused = focus as { sessionId: string | null; selected: boolean };
          setSid((current) =>
            follow
              ? focused.selected
                ? focused.sessionId
                : params.get("session") || list[0]?.id || null
              : current || params.get("session") || list[0]?.id || null,
          );
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
      document.body.classList.remove("native-pet");
    };
  }, [follow]);
  return (
    <main className="pet-standalone-page">
      <div className="pet-task-picker">
        <select
          aria-label="宠物关注的任务"
          value={sid ?? ""}
          onChange={(e) => {
            setFollow(false);
            setSid(e.target.value || null);
          }}
        >
          <option value="">选择一个任务</option>
          {sessions.map((s) => (
            <option value={s.id} key={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          跟随工作台
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      <CompanionWidget sessionId={sid} standalone />
    </main>
  );
}
