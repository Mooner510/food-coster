"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Home,
  LogOut,
  Settings,
  Smartphone,
  Trash2,
  Upload,
  Utensils,
  WifiOff,
  X,
} from "lucide-react";
import {
  authVerifier,
  decryptCsvWithKey,
  deriveVaultKey,
  encryptCsvWithKey,
  hashVerifier,
  makeInitialVault,
  unlockVault,
  type EncryptedVault,
  type VaultKey,
} from "@/lib/crypto";
import {
  cycleRangeForDate,
  dateKey,
  defaultData,
  dinnerEligible,
  fromDateKey,
  mealAllowance,
  nextCycleStart,
  parseCsv,
  periodSummary,
  rulesForDate,
  serializeCsv,
  type AppData,
  type MealEntry,
  type Ruleset,
} from "@/lib/model";
import { deleteLocal, loadLocal, saveLocal } from "@/lib/storage";
import { mergeAppData, sameAppData } from "@/lib/sync";

type View = "home" | "calendar" | "settings";
type SyncState = "saved" | "saving" | "offline" | "conflict";
type Session = {
  username: string;
  verifier: string;
  verifierHash: string;
  key: VaultKey;
  salt: string;
  serverRevision: number;
};
type ApiResult = {
  error?: string;
  vault?: string;
  revision?: number;
  updatedAt?: number;
  conflict?: boolean;
  deleted?: boolean;
};
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const money = (value: number) => `${Math.max(0, Math.round(value)).toLocaleString("ko-KR")}원`;
const normalizeUser = (value: string) => value.trim().toLowerCase();
const nowKey = () => dateKey(new Date());

async function api(body: Record<string, unknown>) {
  const response = await fetch("/api/vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as ApiResult;
  if (!response.ok) throw Object.assign(new Error(payload.error || "요청에 실패했습니다."), { payload, status: response.status });
  return payload;
}

export default function Page() {
  const [data, setData] = useState<AppData>(() => defaultData());
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>("home");
  const [syncState, setSyncState] = useState<SyncState>("saved");
  const [today, setToday] = useState(nowKey());
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const sessionRef = useRef<Session | null>(null);
  const dataRef = useRef(data);
  const pendingSync = useRef(false);
  const saveChain = useRef(Promise.resolve());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef(false);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    const timer = window.setInterval(() => setToday(nowKey()), 30_000);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.clearInterval(timer);
    };
  }, []);

  const writeLocal = useCallback((snapshot: AppData, current: Session, pending: boolean) => {
    const localModifiedAt = Date.now();
    saveChain.current = saveChain.current.then(async () => {
      const vault = await encryptCsvWithKey(serializeCsv(snapshot), current.key, current.salt);
      await saveLocal({
        username: current.username,
        verifierHash: current.verifierHash,
        vault,
        serverRevision: current.serverRevision,
        localModifiedAt,
        pendingSync: pending,
      });
    }).catch(() => undefined);
    return saveChain.current;
  }, []);

  const decryptRemote = useCallback(async (vaultText: string, current: Session) => {
    const vault = JSON.parse(vaultText) as EncryptedVault;
    if (vault.salt !== current.salt) throw new Error("다른 기기에서 암호가 변경되었습니다. 다시 로그인해 주세요.");
    return parseCsv(await decryptCsvWithKey(vault, current.key));
  }, []);

  const synchronize = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || syncing.current || !navigator.onLine) {
      if (current && !navigator.onLine) setSyncState("offline");
      return;
    }

    syncing.current = true;
    setSyncState("saving");
    try {
      if (!pendingSync.current) {
        const remote = await api({ action: "pull", username: current.username, verifier: current.verifier });
        const remoteRevision = Math.max(1, Number(remote.revision ?? 1));
        if (remoteRevision > current.serverRevision && remote.vault) {
          const remoteData = await decryptRemote(remote.vault, current);
          const merged = mergeAppData(dataRef.current, remoteData);
          dataRef.current = merged;
          setData(merged);
          const next = { ...current, serverRevision: remoteRevision };
          sessionRef.current = next;
          setSession(next);
          await writeLocal(merged, next, false);
        }
        setSyncState("saved");
        return;
      }

      const vault = await encryptCsvWithKey(serializeCsv(dataRef.current), current.key, current.salt);
      try {
        const pushed = await api({
          action: "push",
          username: current.username,
          verifier: current.verifier,
          vault: JSON.stringify(vault),
          baseRevision: current.serverRevision,
        });
        const next = {
          ...current,
          serverRevision: Math.max(current.serverRevision + 1, Number(pushed.revision ?? current.serverRevision + 1)),
        };
        sessionRef.current = next;
        setSession(next);
        pendingSync.current = false;
        await writeLocal(dataRef.current, next, false);
        setSyncState("saved");
      } catch (error) {
        const payload = (error as Error & { payload?: ApiResult }).payload;
        if (!payload?.conflict || !payload.vault) throw error;
        setSyncState("conflict");

        const remoteData = await decryptRemote(payload.vault, current);
        const merged = mergeAppData(dataRef.current, remoteData);
        dataRef.current = merged;
        setData(merged);
        const remoteRevision = Math.max(1, Number(payload.revision ?? 1));
        const mergedVault = await encryptCsvWithKey(serializeCsv(merged), current.key, current.salt);
        const retry = await api({
          action: "push",
          username: current.username,
          verifier: current.verifier,
          vault: JSON.stringify(mergedVault),
          baseRevision: remoteRevision,
        });
        const next = { ...current, serverRevision: Number(retry.revision ?? remoteRevision + 1) };
        sessionRef.current = next;
        setSession(next);
        pendingSync.current = false;
        await writeLocal(merged, next, false);
        setSyncState("saved");
      }
    } catch {
      setSyncState(navigator.onLine ? "conflict" : "offline");
    } finally {
      syncing.current = false;
    }
  }, [decryptRemote, writeLocal]);

  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void synchronize(), 700);
  }, [synchronize]);

  const mutate = useCallback((updater: (previous: AppData) => AppData) => {
    const current = sessionRef.current;
    if (!current) return;
    const next = updater(dataRef.current);
    dataRef.current = next;
    setData(next);
    pendingSync.current = true;
    setSyncState(navigator.onLine ? "saving" : "offline");
    void writeLocal(next, current, true);
    scheduleSync();
  }, [scheduleSync, writeLocal]);

  useEffect(() => {
    const online = () => void synchronize();
    const visible = () => { if (document.visibilityState === "visible") void synchronize(); };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [synchronize]);

  const authenticated = useCallback((nextData: AppData, nextSession: Session, pending: boolean) => {
    dataRef.current = nextData;
    sessionRef.current = nextSession;
    pendingSync.current = pending;
    setData(nextData);
    setSession(nextSession);
    setSyncState(pending ? (navigator.onLine ? "saving" : "offline") : "saved");
    if (pending) setTimeout(() => void synchronize(), 0);
  }, [synchronize]);

  const logout = useCallback(() => {
    sessionRef.current = null;
    pendingSync.current = false;
    setSession(null);
    setData(defaultData());
    setView("home");
  }, []);

  const exportBackup = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    const vault = await encryptCsvWithKey(serializeCsv(dataRef.current), current.key, current.salt);
    const blob = new Blob([JSON.stringify(vault)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `food-coster-${dateKey(new Date())}.csv.enc`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const importBackup = useCallback(async (file: File, password: string) => {
    if (password.length < 8) throw new Error("백업 암호를 입력해 주세요.");
    const vault = JSON.parse(await file.text()) as EncryptedVault;
    const unlocked = await unlockVault(vault, password);
    const restored = parseCsv(unlocked.csv);
    mutate(() => restored);
  }, [mutate]);

  const changePassword = useCallback(async (password: string) => {
    const current = sessionRef.current;
    if (!current || password.length < 8) throw new Error("새 암호는 8자 이상이어야 합니다.");
    await saveChain.current;
    if (pendingSync.current) await synchronize();
    const fresh = sessionRef.current;
    if (!fresh || pendingSync.current) throw new Error("동기화 후 다시 시도해 주세요.");

    const newVerifier = await authVerifier(fresh.username, password);
    const newVerifierHash = await hashVerifier(newVerifier);
    const { key, salt } = await deriveVaultKey(password);
    const vault = await encryptCsvWithKey(serializeCsv(dataRef.current), key, salt);
    const result = await api({
      action: "change_credentials",
      username: fresh.username,
      verifier: fresh.verifier,
      newVerifier,
      vault: JSON.stringify(vault),
      baseRevision: fresh.serverRevision,
    });
    const next: Session = {
      username: fresh.username,
      verifier: newVerifier,
      verifierHash: newVerifierHash,
      key,
      salt,
      serverRevision: Number(result.revision ?? fresh.serverRevision + 1),
    };
    sessionRef.current = next;
    setSession(next);
    await writeLocal(dataRef.current, next, false);
  }, [synchronize, writeLocal]);

  const deleteAccount = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    await api({ action: "delete", username: current.username, verifier: current.verifier });
    await deleteLocal(current.username);
    logout();
  }, [logout]);

  const install = useCallback(async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }, [installPrompt]);

  if (!session) return <AuthScreen onAuthenticated={authenticated} />;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><div className="eyebrow">FOOD COSTER</div><strong>{session.username}</strong></div>
        <div className={`sync ${syncState}`}>
          {syncState === "saving" ? "저장 중" : syncState === "offline" ? <><WifiOff size={14}/> 오프라인</> : syncState === "conflict" ? "동기화 중" : <><Check size={14}/> 저장됨</>}
        </div>
      </header>
      <section className="content">
        {view === "home" && <HomeView data={data} today={today} mutate={mutate} />}
        {view === "calendar" && <CalendarView data={data} today={today} mutate={mutate} />}
        {view === "settings" && <SettingsView
          data={data}
          session={session}
          mutate={mutate}
          installable={!!installPrompt}
          onInstall={install}
          onExport={exportBackup}
          onImport={importBackup}
          onChangePassword={changePassword}
          onDelete={deleteAccount}
          onLogout={logout}
        />}
      </section>
      <nav className="bottom-nav">
        <NavButton active={view === "home"} label="홈" onClick={() => setView("home")}><Home size={22}/></NavButton>
        <NavButton active={view === "calendar"} label="달력" onClick={() => setView("calendar")}><CalendarDays size={22}/></NavButton>
        <NavButton active={view === "settings"} label="설정" onClick={() => setView("settings")}><Settings size={22}/></NavButton>
      </nav>
    </main>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (data: AppData, session: Session, pending: boolean) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const user = normalizeUser(username);
    if (!/^[a-z0-9._-]{3,32}$/.test(user)) return setError("사용자명은 영문 소문자·숫자 3자 이상으로 입력해 주세요.");
    if (password.length < 8) return setError("암호는 8자 이상이어야 합니다.");
    setBusy(true);
    setError("");
    try {
      const verifier = await authVerifier(user, password);
      const verifierHash = await hashVerifier(verifier);
      if (mode === "register") {
        const initial = defaultData();
        const created = await makeInitialVault(serializeCsv(initial), password);
        const result = await api({ action: "register", username: user, verifier, vault: JSON.stringify(created.vault) });
        const revision = Number(result.revision ?? 1);
        await saveLocal({ username: user, verifierHash, vault: created.vault, serverRevision: revision, localModifiedAt: Date.now(), pendingSync: false });
        onAuthenticated(initial, { username: user, verifier, verifierHash, key: created.key, salt: created.salt, serverRevision: revision }, false);
        return;
      }

      const local = await loadLocal(user);
      let localData: AppData | null = null;
      let localKey: VaultKey | null = null;
      let localSalt = "";
      let localNeedsReencrypt = false;
      if (local && local.verifierHash === verifierHash) {
        const unlocked = await unlockVault(local.vault, password);
        localData = parseCsv(unlocked.csv);
        localKey = unlocked.key;
        localSalt = unlocked.salt;
        localNeedsReencrypt = unlocked.needsReencrypt;
      }

      try {
        const result = await api({ action: "login", username: user, verifier });
        if (!result.vault) throw new Error("서버 데이터가 없습니다.");
        const remoteVault = JSON.parse(result.vault) as EncryptedVault;
        const remoteUnlocked = await unlockVault(remoteVault, password);
        const remoteData = parseCsv(remoteUnlocked.csv);
        const merged = localData ? mergeAppData(localData, remoteData) : remoteData;
        const pending = Boolean(local?.pendingSync) || localNeedsReencrypt || remoteUnlocked.needsReencrypt || !sameAppData(merged, remoteData);
        const key = remoteUnlocked.key;
        const salt = remoteUnlocked.salt;
        const revision = Number(result.revision ?? 1);
        const vault = await encryptCsvWithKey(serializeCsv(merged), key, salt);
        await saveLocal({ username: user, verifierHash, vault, serverRevision: revision, localModifiedAt: Date.now(), pendingSync: pending });
        onAuthenticated(merged, { username: user, verifier, verifierHash, key, salt, serverRevision: revision }, pending);
      } catch (onlineError) {
        if (!localData || !localKey) throw onlineError;
        const vault = await encryptCsvWithKey(serializeCsv(localData), localKey, localSalt);
        await saveLocal({ username: user, verifierHash, vault, serverRevision: local?.serverRevision ?? 0, localModifiedAt: Date.now(), pendingSync: true });
        onAuthenticated(localData, { username: user, verifier, verifierHash, key: localKey, salt: localSalt, serverRevision: local?.serverRevision ?? 0 }, true);
      }
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "로그인할 수 없습니다.");
    } finally {
      setBusy(false);
    }
  };

  return <main className="auth-wrap"><section className="auth-card">
    <div className="logo"><Utensils size={26}/></div>
    <h1>Food Coster</h1>
    <p>식대만 빠르게 기록하세요.</p>
    <div className="segmented">
      <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>로그인</button>
      <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>처음 시작</button>
    </div>
    <label className="field"><span>사용자명</span><input value={username} autoCapitalize="none" autoCorrect="off" onChange={(event) => setUsername(event.target.value)} placeholder="username" /></label>
    <label className="field"><span>암호</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="8자 이상" onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} /></label>
    {error && <div className="error">{error}</div>}
    <button className="primary" disabled={busy} onClick={() => void submit()}>{busy ? "확인 중..." : mode === "login" ? "로그인" : "시작하기"}</button>
  </section></main>;
}

function HomeView({ data, today, mutate }: { data: AppData; today: string; mutate: (fn: (data: AppData) => AppData) => void }) {
  const summary = useMemo(() => periodSummary(data, fromDateKey(today)), [data, today]);
  const target = fromDateKey(today);
  return <div className="stack">
    <section className="hero-card">
      <span>지금 사용 가능</span><strong>{money(summary.availableNow)}</strong>
      <div className="meal-available"><span>점심 {money(summary.lunchAvailableNow)}</span><span>저녁 {money(summary.dinnerAvailableNow)}</span></div>
      <div className="hero-meta"><span>{dateKey(summary.start)} ~ {dateKey(summary.end)}</span><span>{money(summary.usedToDate)} 사용</span></div>
      <div className="progress"><i style={{ width: `${summary.total ? Math.min(100, summary.usedToDate / summary.total * 100) : 0}%` }} /></div>
    </section>
    <div className="summary-grid"><Mini label="기간 전체" value={money(summary.total)}/><Mini label="앞으로 사용 가능" value={money(summary.futureAvailable)}/></div>
    <section><div className="section-title"><h2>오늘</h2><span>{new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(target)}</span></div><DayEditor date={today} data={data} mutate={mutate}/></section>
  </div>;
}

function CalendarView({ data, today, mutate }: { data: AppData; today: string; mutate: (fn: (data: AppData) => AppData) => void }) {
  const now = fromDateKey(today);
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const [selected, setSelected] = useState(today);
  const range = cycleRangeForDate(data, fromDateKey(selected));
  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [month]);

  const move = (offset: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next);
    setSelected(dateKey(new Date(next.getFullYear(), next.getMonth(), 1)));
  };

  return <div className="stack">
    <section className="calendar-card">
      <div className="calendar-head"><button className="icon-btn" onClick={() => move(-1)}><ChevronLeft/></button><h2>{month.getFullYear()}년 {month.getMonth() + 1}월</h2><button className="icon-btn" onClick={() => move(1)}><ChevronRight/></button></div>
      <div className="week"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
      <div className="days">{days.map((date) => {
        const key = dateKey(date);
        const entry = data.entries[key];
        const spent = (entry?.lunch ?? 0) + (entry?.dinner ?? 0);
        const inPeriod = date >= range.start && date <= range.end;
        return <button key={key} className={`${selected === key ? "selected" : ""} ${date.getMonth() !== month.getMonth() ? "muted" : ""} ${key === today ? "today" : ""} ${inPeriod ? "period" : ""}`} onClick={() => setSelected(key)}><b>{date.getDate()}</b>{spent > 0 && <small>{spent >= 10_000 ? `${Math.round(spent / 1000)}k` : spent.toLocaleString()}</small>}</button>;
      })}</div>
    </section>
    <section><div className="section-title"><h2>{new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(fromDateKey(selected))}</h2><span>{dateKey(range.start)} ~ {dateKey(range.end)}</span></div><DayEditor date={selected} data={data} mutate={mutate}/></section>
  </div>;
}

function DayEditor({ date, data, mutate }: { date: string; data: AppData; mutate: (fn: (data: AppData) => AppData) => void }) {
  const [daySheet, setDaySheet] = useState(false);
  const entry = data.entries[date] ?? { date, lunch: 0, dinner: 0, updatedAt: 0 };
  const target = fromDateKey(date);
  const allowance = mealAllowance(data, target);
  const work = allowance.workday;
  const dinnerOn = dinnerEligible(target, data);
  const update = (patch: Partial<MealEntry>) => mutate((previous) => ({
    ...previous,
    entries: {
      ...previous.entries,
      [date]: {
        ...(previous.entries[date] ?? { date, lunch: 0, dinner: 0, updatedAt: 0 }),
        ...patch,
        updatedAt: Date.now(),
      },
    },
  }));

  return <>
    <div className="meal-card">
      <MealRow title="점심" budget={allowance.lunch} value={entry.lunch} inactive={!work} onChange={(value) => update({ lunch: value })}/>
      <div className="divider"/>
      <MealRow title="저녁" budget={allowance.dinner} value={entry.dinner} inactive={!dinnerOn} onChange={(value) => update({ dinner: value })}/>
      <div className="day-options">
        {allowance.rule.dinnerPolicy === "CONDITIONAL" && work && <button className={`chip ${entry.dinnerEligible ? "on" : ""}`} onClick={() => update({ dinnerEligible: !entry.dinnerEligible })}>{entry.dinnerEligible ? "저녁 제공" : "저녁 미제공"}</button>}
        <button className={`chip ${entry.dayOverride ? "on" : ""}`} onClick={() => setDaySheet(true)}>{entry.dayOverride === "ON" ? "식대 제공" : entry.dayOverride === "OFF" ? "식대 제외" : "기본 일정"}</button>
      </div>
    </div>
    {daySheet && <Sheet title="이 날짜" onClose={() => setDaySheet(false)}>
      <SheetChoice label="기본 규칙 적용" selected={!entry.dayOverride} onClick={() => { update({ dayOverride: undefined }); setDaySheet(false); }}/>
      <SheetChoice label="식대 제공" selected={entry.dayOverride === "ON"} onClick={() => { update({ dayOverride: "ON" }); setDaySheet(false); }}/>
      <SheetChoice label="식대 제외" selected={entry.dayOverride === "OFF"} onClick={() => { update({ dayOverride: "OFF" }); setDaySheet(false); }}/>
    </Sheet>}
  </>;
}

function MealRow({ title, budget, value, inactive, onChange }: { title: string; budget: number; value: number; inactive: boolean; onChange: (value: number) => void }) {
  const remain = Math.max(0, budget - value);
  const editableExisting = inactive && value > 0;
  return <div className={`meal-row ${inactive ? "disabled" : ""}`}>
    <div><strong>{title}</strong><span>{inactive ? editableExisting ? "대상 아님 · 기존 기록 수정 가능" : "대상 아님" : `${money(budget)} · ${money(remain)} 남음`}</span></div>
    <div className="meal-input-wrap">
      <button className="fill-btn" disabled={inactive} onClick={() => onChange(budget)}>전액</button>
      <div className="money-input"><input inputMode="numeric" disabled={inactive && !editableExisting} value={value ? String(value) : ""} placeholder="0" onChange={(event) => onChange(Math.max(0, Number(event.target.value.replace(/\D/g, "")) || 0))}/><span>원</span></div>
    </div>
  </div>;
}

function SettingsView({ data, session, mutate, installable, onInstall, onExport, onImport, onChangePassword, onDelete, onLogout }: {
  data: AppData;
  session: Session;
  mutate: (fn: (data: AppData) => AppData) => void;
  installable: boolean;
  onInstall: () => Promise<void>;
  onExport: () => Promise<void>;
  onImport: (file: File, password: string) => Promise<void>;
  onChangePassword: (password: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onLogout: () => void;
}) {
  const [applyFrom, setApplyFrom] = useState<"current" | "next">("next");
  const [picker, setPicker] = useState<{ title: string; value: string; options: [string, string][]; apply: (value: string) => void } | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [dangerOpen, setDangerOpen] = useState(false);
  const [dangerText, setDangerText] = useState("");
  const [status, setStatus] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const active = rulesForDate(data, new Date());
  const range = cycleRangeForDate(data, new Date());
  const effectiveFrom = applyFrom === "current" ? dateKey(range.start) : dateKey(nextCycleStart(data));
  const editable = data.rulesets.filter((rule) => rule.effectiveFrom === effectiveFrom).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? active;

  const patch = (values: Partial<Ruleset>) => mutate((previous) => {
    const existing = previous.rulesets.filter((rule) => rule.effectiveFrom === effectiveFrom).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const updated: Ruleset = {
      ...(existing ?? editable),
      ...values,
      id: existing?.id ?? `rules-${effectiveFrom}`,
      effectiveFrom,
      updatedAt: Date.now(),
    };
    return { ...previous, rulesets: [...previous.rulesets.filter((rule) => rule.id !== updated.id), updated] };
  });

  const choose = (title: string, value: string, options: [string, string][], apply: (value: string) => void) => setPicker({ title, value, options, apply });
  const run = async (job: () => Promise<void>, success: string) => {
    setStatus("");
    try { await job(); setStatus(success); }
    catch (error) { setStatus(error instanceof Error ? error.message : "처리하지 못했습니다."); }
  };

  return <div className="stack settings-page"><div className="page-title"><h1>설정</h1></div>
    <div className="apply-switch"><button className={applyFrom === "current" ? "active" : ""} onClick={() => setApplyFrom("current")}>현재 기간</button><button className={applyFrom === "next" ? "active" : ""} onClick={() => setApplyFrom("next")}>다음 기간</button></div>
    <SettingsGroup title="식대"><MoneySetting label="점심 식대" value={editable.lunchBudget} onChange={(value) => patch({ lunchBudget: value })}/><MoneySetting label="저녁 식대" value={editable.dinnerBudget} onChange={(value) => patch({ dinnerBudget: value })}/></SettingsGroup>
    <SettingsGroup title="근무일">
      <ChoiceSetting label="식대 제공일" value={labelOf(editable.workdayMode, [["WEEKDAYS", "평일만"], ["SATURDAY", "토요일 포함"], ["SUNDAY", "일요일 포함"], ["EVERYDAY", "매일"]])} onClick={() => choose("식대 제공일", editable.workdayMode, [["WEEKDAYS", "평일만"], ["SATURDAY", "토요일 포함"], ["SUNDAY", "일요일 포함"], ["EVERYDAY", "매일"]], (value) => patch({ workdayMode: value as Ruleset["workdayMode"] }))}/>
      <ToggleSetting label="공휴일 제외" checked={editable.excludeKrPublicHolidays} onChange={(checked) => patch({ excludeKrPublicHolidays: checked })}/>
    </SettingsGroup>
    <SettingsGroup title="점심"><ChoiceSetting label="미사용 식대" value={editable.lunchCarry === "DAILY" ? "당일 소멸" : "누계액 포함"} onClick={() => choose("점심 미사용 식대", editable.lunchCarry, [["DAILY", "당일 소멸"], ["CARRY", "누계액 포함"]], (value) => patch({ lunchCarry: value as Ruleset["lunchCarry"] }))}/></SettingsGroup>
    <SettingsGroup title="저녁">
      <ChoiceSetting label="제공 방식" value={labelOf(editable.dinnerPolicy, [["ALWAYS", "항상 제공"], ["CONDITIONAL", "날짜별 설정"], ["NONE", "미제공"]])} onClick={() => choose("저녁 제공 방식", editable.dinnerPolicy, [["ALWAYS", "항상 제공"], ["CONDITIONAL", "날짜별 설정"], ["NONE", "미제공"]], (value) => patch({ dinnerPolicy: value as Ruleset["dinnerPolicy"] }))}/>
      {editable.dinnerPolicy !== "NONE" && <ChoiceSetting label="미사용 식대" value={editable.dinnerCarry === "DAILY" ? "당일 소멸" : "누계액 포함"} onClick={() => choose("저녁 미사용 식대", editable.dinnerCarry, [["DAILY", "당일 소멸"], ["CARRY", "누계액 포함"]], (value) => patch({ dinnerCarry: value as Ruleset["dinnerCarry"] }))}/>} 
    </SettingsGroup>
    <SettingsGroup title="정산"><label className="setting-row"><span><strong>기준일</strong><small>{effectiveFrom}부터 적용</small></span><div className="day-input">매월 <input inputMode="numeric" value={editable.cycleDay} onChange={(event) => patch({ cycleDay: Math.min(31, Math.max(1, Number(event.target.value) || 1)) })}/>일</div></label></SettingsGroup>
    <SettingsGroup title="데이터">
      {installable && <ActionSetting icon={<Smartphone size={18}/>} label="앱 설치" onClick={() => void onInstall()}/>} 
      <ActionSetting icon={<Download size={18}/>} label="암호화 백업 내보내기" onClick={() => void onExport()}/>
      <ActionSetting icon={<Upload size={18}/>} label="암호화 백업 가져오기" onClick={() => fileRef.current?.click()}/>
      <input ref={fileRef} hidden type="file" accept=".enc,application/octet-stream" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setBackupFile(file); setBackupPassword(""); } event.currentTarget.value = ""; }}/>
      <ActionSetting label="암호 변경" onClick={() => setPasswordOpen(true)}/>
    </SettingsGroup>
    {status && <div className="notice">{status}</div>}
    <button className="logout" onClick={onLogout}><LogOut size={18}/> 로그아웃</button>
    <button className="danger-link" onClick={() => setDangerOpen(true)}><Trash2 size={16}/> 계정 삭제</button>

    {picker && <Sheet title={picker.title} onClose={() => setPicker(null)}>{picker.options.map(([value, label]) => <SheetChoice key={value} label={label} selected={picker.value === value} onClick={() => { picker.apply(value); setPicker(null); }}/>)}</Sheet>}
    {passwordOpen && <Sheet title="암호 변경" onClose={() => { setPasswordOpen(false); setNewPassword(""); }}><label className="field sheet-field"><span>새 암호</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="8자 이상" /></label><button className="primary" onClick={() => void run(async () => { await onChangePassword(newPassword); setPasswordOpen(false); setNewPassword(""); }, "암호를 변경했습니다.")}>변경</button></Sheet>}
    {backupFile && <Sheet title="백업 복원" onClose={() => { setBackupFile(null); setBackupPassword(""); }}><p className="sheet-copy">백업을 만들 때 사용한 암호를 입력하세요.</p><label className="field sheet-field"><span>백업 암호</span><input type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} placeholder="8자 이상" /></label><button className="primary" disabled={backupPassword.length < 8} onClick={() => void run(async () => { await onImport(backupFile, backupPassword); setBackupFile(null); setBackupPassword(""); }, "복원했습니다.")}>복원</button></Sheet>}
    {dangerOpen && <Sheet title="계정 삭제" onClose={() => { setDangerOpen(false); setDangerText(""); }}><p className="sheet-copy">삭제하려면 <strong>{session.username}</strong> 입력</p><label className="field sheet-field"><input value={dangerText} onChange={(event) => setDangerText(event.target.value)} /></label><button className="danger-button" disabled={dangerText !== session.username} onClick={() => void onDelete()}>영구 삭제</button></Sheet>}
  </div>;
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section><div className="group-title">{title}</div><div className="settings-card">{children}</div></section>; }
function MoneySetting({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <label className="setting-row"><strong>{label}</strong><div className="money-input compact"><input inputMode="numeric" value={value} onChange={(event) => onChange(Math.max(0, Number(event.target.value.replace(/\D/g, "")) || 0))}/><span>원</span></div></label>; }
function ChoiceSetting({ label, value, onClick }: { label: string; value: string; onClick: () => void }) { return <button className="setting-row setting-button" onClick={onClick}><strong>{label}</strong><span className="choice-value">{value}<ChevronDown size={15}/></span></button>; }
function ToggleSetting({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="setting-row"><strong>{label}</strong><input className="toggle" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}/></label>; }
function ActionSetting({ icon, label, onClick }: { icon?: React.ReactNode; label: string; onClick: () => void }) { return <button className="setting-row setting-button" onClick={onClick}><span className="action-label">{icon}{label}</span><ChevronRight size={17}/></button>; }
function Mini({ label, value }: { label: string; value: string }) { return <div className="mini-card"><span>{label}</span><strong>{value}</strong></div>; }
function NavButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) { return <button className={active ? "active" : ""} onClick={onClick}>{children}<span>{label}</span></button>; }
function labelOf(value: string, options: [string, string][]) { return options.find(([key]) => key === value)?.[1] ?? value; }

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="sheet"><div className="sheet-head"><strong>{title}</strong><button className="icon-btn" onClick={onClose}><X size={20}/></button></div>{children}</div></div>;
}

function SheetChoice({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return <button className="sheet-choice" onClick={onClick}><span>{label}</span>{selected && <Check size={19}/>}</button>;
}
