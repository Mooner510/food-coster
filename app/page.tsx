"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Home, LogOut, Settings, Utensils, WifiOff } from "lucide-react";
import { authVerifier, decryptCsv, encryptCsv, hashVerifier, type EncryptedVault } from "@/lib/crypto";
import { loadLocal, saveLocal } from "@/lib/storage";
import { dateKey, defaultData, dinnerEligible, fromDateKey, isWorkday, parseCsv, periodSummary, serializeCsv, type AppData, type MealEntry } from "@/lib/model";

type View = "home" | "calendar" | "settings";
type Session = { username: string; password: string; verifier: string; verifierHash: string; updatedAt: number; salt?: string };

const money = (value: number) => `${Math.max(0, Math.round(value)).toLocaleString("ko-KR")}원`;
const todayKey = () => dateKey(new Date());
const normalizeUser = (value: string) => value.trim().toLowerCase();

async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { error?: string; vault?: string; updatedAt?: number; conflict?: boolean };
  if (!response.ok) throw Object.assign(new Error(payload.error || "요청에 실패했습니다."), { payload });
  return payload;
}

export default function Page() {
  const [data, setData] = useState<AppData>(() => defaultData());
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("home");
  const [dirty, setDirty] = useState(false);
  const [syncState, setSyncState] = useState<"saved"|"saving"|"offline"|"conflict">("saved");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined); }, []);

  const mutate = useCallback((updater: (prev: AppData) => AppData) => {
    setData(prev => updater(prev));
    setDirty(true);
  }, []);

  const save = useCallback(async (snapshot: AppData, current: Session) => {
    setSyncState("saving");
    const csv = serializeCsv(snapshot);
    const vault = await encryptCsv(csv, current.password, current.salt);
    await saveLocal({ username: current.username, verifierHash: current.verifierHash, vault, updatedAt: Date.now() });
    setSession(prev => prev ? { ...prev, salt: vault.salt } : prev);
    if (!navigator.onLine) { setSyncState("offline"); return; }
    try {
      const result = await api({ action: "push", username: current.username, verifier: current.verifier, vault: JSON.stringify(vault), baseUpdatedAt: current.updatedAt });
      const updatedAt = Number(result.updatedAt || Date.now());
      await saveLocal({ username: current.username, verifierHash: current.verifierHash, vault, updatedAt });
      setSession(prev => prev ? { ...prev, updatedAt, salt: vault.salt } : prev);
      setSyncState("saved");
    } catch (error) {
      const payload = (error as Error & { payload?: { conflict?: boolean } }).payload;
      setSyncState(payload?.conflict ? "conflict" : "offline");
    }
  }, []);

  useEffect(() => {
    if (!dirty || !session) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = data;
    const current = session;
    saveTimer.current = setTimeout(() => { setDirty(false); void save(snapshot, current); }, 450);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [data, dirty, save, session]);

  if (!session) return <AuthScreen onAuthenticated={(nextData, nextSession) => { setData(nextData); setSession(nextSession); }} />;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><div className="eyebrow">FOOD COSTER</div><strong>{session.username}</strong></div>
        <div className={`sync ${syncState}`}>
          {syncState === "saving" ? "저장 중" : syncState === "offline" ? <><WifiOff size={14}/> 오프라인</> : syncState === "conflict" ? "동기화 충돌" : "저장됨"}
        </div>
      </header>

      <section className="content">
        {view === "home" && <HomeView data={data} mutate={mutate} />}
        {view === "calendar" && <CalendarView data={data} mutate={mutate} />}
        {view === "settings" && <SettingsView data={data} mutate={mutate} onLogout={() => { setSession(null); setData(defaultData()); }} />}
      </section>

      <nav className="bottom-nav">
        <NavButton active={view === "home"} label="홈" onClick={() => setView("home")}><Home size={22}/></NavButton>
        <NavButton active={view === "calendar"} label="달력" onClick={() => setView("calendar")}><CalendarDays size={22}/></NavButton>
        <NavButton active={view === "settings"} label="설정" onClick={() => setView("settings")}><Settings size={22}/></NavButton>
      </nav>
    </main>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (data: AppData, session: Session) => void }) {
  const [mode, setMode] = useState<"login"|"register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const user = normalizeUser(username);
    if (!/^[a-z0-9._-]{3,32}$/.test(user)) return setError("사용자명은 영문 소문자·숫자 3자 이상으로 입력해 주세요.");
    if (password.length < 8) return setError("암호는 8자 이상이어야 합니다.");
    setBusy(true); setError("");
    try {
      const verifier = await authVerifier(user, password);
      const verifierHash = await hashVerifier(verifier);
      if (mode === "register") {
        const initial = defaultData();
        const vault = await encryptCsv(serializeCsv(initial), password);
        const result = await api({ action: "register", username: user, verifier, vault: JSON.stringify(vault) });
        const updatedAt = Number(result.updatedAt || Date.now());
        await saveLocal({ username: user, verifierHash, vault, updatedAt });
        onAuthenticated(initial, { username: user, password, verifier, verifierHash, updatedAt, salt: vault.salt });
        return;
      }

      try {
        const result = await api({ action: "login", username: user, verifier });
        const vault = JSON.parse(String(result.vault)) as EncryptedVault;
        const parsed = parseCsv(await decryptCsv(vault, password));
        const updatedAt = Number(result.updatedAt || Date.now());
        await saveLocal({ username: user, verifierHash, vault, updatedAt });
        onAuthenticated(parsed, { username: user, password, verifier, verifierHash, updatedAt, salt: vault.salt });
      } catch (onlineError) {
        const local = await loadLocal(user);
        if (!local || local.verifierHash !== verifierHash) throw onlineError;
        const parsed = parseCsv(await decryptCsv(local.vault, password));
        onAuthenticated(parsed, { username: user, password, verifier, verifierHash, updatedAt: local.updatedAt, salt: local.vault.salt });
      }
    } catch (e) { setError(e instanceof Error ? e.message : "로그인할 수 없습니다."); }
    finally { setBusy(false); }
  };

  return <main className="auth-wrap"><section className="auth-card">
    <div className="logo"><Utensils size={26}/></div>
    <h1>Food Coster</h1>
    <p>식대만 빠르게 기록하세요.</p>
    <div className="segmented"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>로그인</button><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>처음 시작</button></div>
    <label className="field"><span>사용자명</span><input value={username} autoCapitalize="none" autoCorrect="off" onChange={e => setUsername(e.target.value)} placeholder="username" /></label>
    <label className="field"><span>암호</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="8자 이상" onKeyDown={e => { if (e.key === "Enter") void submit(); }} /></label>
    {error && <div className="error">{error}</div>}
    <button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "확인 중..." : mode === "login" ? "로그인" : "시작하기"}</button>
  </section></main>;
}

function HomeView({ data, mutate }: { data: AppData; mutate: (fn: (d: AppData) => AppData) => void }) {
  const summary = useMemo(() => periodSummary(data), [data]);
  return <div className="stack">
    <section className="hero-card">
      <span>지금 사용 가능</span><strong>{money(summary.availableNow)}</strong>
      <div className="hero-meta"><span>{dateKey(summary.start)} ~ {dateKey(summary.end)}</span><span>{money(summary.used)} 사용</span></div>
      <div className="progress"><i style={{ width: `${summary.total ? Math.min(100, summary.used / summary.total * 100) : 0}%` }} /></div>
    </section>
    <div className="summary-grid"><Mini label="기간 한도" value={money(summary.total)}/><Mini label="남은 한도" value={money(summary.remaining)}/></div>
    <section><div className="section-title"><h2>오늘</h2><span>{new Intl.DateTimeFormat("ko-KR", { month:"long", day:"numeric", weekday:"short" }).format(new Date())}</span></div><DayEditor date={todayKey()} data={data} mutate={mutate}/></section>
  </div>;
}

function CalendarView({ data, mutate }: { data: AppData; mutate: (fn: (d: AppData) => AppData) => void }) {
  const now = new Date();
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = useState(todayKey());
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first); start.setDate(1-first.getDay());
    return Array.from({length:42}, (_,i) => { const d = new Date(start); d.setDate(start.getDate()+i); return d; });
  }, [month]);
  return <div className="stack">
    <section className="calendar-card">
      <div className="calendar-head"><button className="icon-btn" onClick={() => setMonth(m => new Date(m.getFullYear(),m.getMonth()-1,1))}><ChevronLeft/></button><h2>{month.getFullYear()}년 {month.getMonth()+1}월</h2><button className="icon-btn" onClick={() => setMonth(m => new Date(m.getFullYear(),m.getMonth()+1,1))}><ChevronRight/></button></div>
      <div className="week"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div className="days">{days.map(d => { const key = dateKey(d); const entry = data.entries[key]; const spent = (entry?.lunch||0)+(entry?.dinner||0); const muted = d.getMonth() !== month.getMonth(); return <button key={key} className={`${selected===key?"selected":""} ${muted?"muted":""}`} onClick={() => setSelected(key)}><b>{d.getDate()}</b>{spent > 0 && <small>{spent >= 10000 ? `${Math.round(spent/1000)}k` : spent.toLocaleString()}</small>}</button>; })}</div>
    </section>
    <section><div className="section-title"><h2>{new Intl.DateTimeFormat("ko-KR", { month:"long", day:"numeric", weekday:"short" }).format(fromDateKey(selected))}</h2></div><DayEditor date={selected} data={data} mutate={mutate}/></section>
  </div>;
}

function DayEditor({ date, data, mutate }: { date: string; data: AppData; mutate: (fn: (d: AppData) => AppData) => void }) {
  const entry = data.entries[date] ?? { date, lunch:0, dinner:0 };
  const d = fromDateKey(date);
  const work = isWorkday(d, data.rules, entry);
  const dinnerOn = dinnerEligible(d, data);
  const update = (patch: Partial<MealEntry>) => mutate(prev => ({ ...prev, entries: { ...prev.entries, [date]: { ...(prev.entries[date] ?? { date, lunch:0, dinner:0 }), ...patch } } }));
  return <div className="meal-card">
    <MealRow title="점심" budget={work ? data.rules.lunchBudget : 0} value={entry.lunch} disabled={!work} onChange={v => update({ lunch:v })}/>
    <div className="divider"/>
    <MealRow title="저녁" budget={dinnerOn ? data.rules.dinnerBudget : 0} value={entry.dinner} disabled={!dinnerOn} onChange={v => update({ dinner:v })}/>
    {(data.rules.dinnerPolicy === "CONDITIONAL" || !work) && <div className="day-options">
      {data.rules.dinnerPolicy === "CONDITIONAL" && work && <button className={`chip ${entry.dinnerEligible?"on":""}`} onClick={() => update({ dinnerEligible: !entry.dinnerEligible })}>{entry.dinnerEligible ? "저녁 제공" : "저녁 미제공"}</button>}
      <button className={`chip ${entry.dayOverride ? "on" : ""}`} onClick={() => update({ dayOverride: entry.dayOverride === "ON" ? "OFF" : entry.dayOverride === "OFF" ? undefined : "ON" })}>{entry.dayOverride === "ON" ? "식대일" : entry.dayOverride === "OFF" ? "제외일" : "기본 근무일 규칙"}</button>
    </div>}
  </div>;
}

function MealRow({ title, budget, value, disabled, onChange }: { title:string; budget:number; value:number; disabled:boolean; onChange:(v:number)=>void }) {
  const remain = Math.max(0,budget-value);
  return <div className={`meal-row ${disabled?"disabled":""}`}><div><strong>{title}</strong><span>{disabled ? "대상 아님" : `${money(budget)} · ${money(remain)} 남음`}</span></div><div className="money-input"><input inputMode="numeric" disabled={disabled} value={value ? String(value) : ""} placeholder="0" onChange={e => onChange(Math.max(0, Number(e.target.value.replace(/\D/g,"")) || 0))}/><span>원</span></div></div>;
}

function SettingsView({ data, mutate, onLogout }: { data: AppData; mutate:(fn:(d:AppData)=>AppData)=>void; onLogout:()=>void }) {
  const r = data.rules;
  const patch = (next: Partial<typeof r>) => mutate(prev => ({ ...prev, rules:{...prev.rules,...next} }));
  return <div className="stack settings-page"><div className="page-title"><h1>설정</h1></div>
    <SettingsGroup title="식대"><MoneySetting label="점심 식대" value={r.lunchBudget} onChange={v=>patch({lunchBudget:v})}/><MoneySetting label="저녁 식대" value={r.dinnerBudget} onChange={v=>patch({dinnerBudget:v})}/></SettingsGroup>
    <SettingsGroup title="근무일"><SelectSetting label="식대 제공일" value={r.workdayMode} onChange={v=>patch({workdayMode:v as typeof r.workdayMode})} options={[["WEEKDAYS","평일만"],["SATURDAY","토요일 포함"],["SUNDAY","일요일 포함"],["EVERYDAY","매일"]]}/></SettingsGroup>
    <SettingsGroup title="점심"><SelectSetting label="미사용 식대" value={r.lunchCarry} onChange={v=>patch({lunchCarry:v as typeof r.lunchCarry})} options={[["DAILY","당일 소멸"],["CARRY","누계액 포함"]]}/></SettingsGroup>
    <SettingsGroup title="저녁"><SelectSetting label="제공 방식" value={r.dinnerPolicy} onChange={v=>patch({dinnerPolicy:v as typeof r.dinnerPolicy})} options={[["ALWAYS","항상 제공"],["CONDITIONAL","날짜별 설정"],["NONE","미제공"]]}/><SelectSetting label="미사용 식대" value={r.dinnerCarry} onChange={v=>patch({dinnerCarry:v as typeof r.dinnerCarry})} options={[["DAILY","당일 소멸"],["CARRY","누계액 포함"]]}/></SettingsGroup>
    <SettingsGroup title="정산"><label className="setting-row"><span><strong>기준일</strong><small>매월 새 식대 기간이 시작되는 날</small></span><div className="day-input">매월 <input inputMode="numeric" value={r.cycleDay} onChange={e=>patch({cycleDay:Math.min(31,Math.max(1,Number(e.target.value)||1))})}/>일</div></label></SettingsGroup>
    <button className="logout" onClick={onLogout}><LogOut size={18}/> 로그아웃</button>
  </div>;
}

function SettingsGroup({title,children}:{title:string;children:React.ReactNode}) { return <section><div className="group-title">{title}</div><div className="settings-card">{children}</div></section>; }
function MoneySetting({label,value,onChange}:{label:string;value:number;onChange:(v:number)=>void}) { return <label className="setting-row"><strong>{label}</strong><div className="money-input compact"><input inputMode="numeric" value={value} onChange={e=>onChange(Math.max(0,Number(e.target.value.replace(/\D/g,""))||0))}/><span>원</span></div></label>; }
function SelectSetting({label,value,onChange,options}:{label:string;value:string;onChange:(v:string)=>void;options:[string,string][]}) { return <label className="setting-row"><strong>{label}</strong><select value={value} onChange={e=>onChange(e.target.value)}>{options.map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label>; }
function Mini({label,value}:{label:string;value:string}) { return <div className="mini-card"><span>{label}</span><strong>{value}</strong></div>; }
function NavButton({active,label,onClick,children}:{active:boolean;label:string;onClick:()=>void;children:React.ReactNode}) { return <button className={active?"active":""} onClick={onClick}>{children}<span>{label}</span></button>; }
