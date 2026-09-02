"use client";

import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "food-coster-theme";
const OPTIONS: { value: ThemePreference; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "시스템", icon: Monitor },
  { value: "light", label: "화이트", icon: Sun },
  { value: "dark", label: "다크", icon: Moon },
];

function resolveTheme(preference: ThemePreference) {
  if (preference !== "system") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;

  const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = resolved === "dark" ? "#111318" : "#f5f6f8";
}

export default function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const initial: ThemePreference = stored === "light" || stored === "dark" ? stored : "system";
    applyTheme(initial);
    const frame = requestAnimationFrame(() => setPreference(initial));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const select = (next: ThemePreference) => {
    setPreference(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    setOpen(false);
  };

  const CurrentIcon = OPTIONS.find((option) => option.value === preference)?.icon ?? Monitor;

  return <div className="theme-control" ref={rootRef}>
    {open && <div className="theme-menu" role="menu" aria-label="화면 테마">
      <div className="theme-menu-title"><Palette size={15}/> 화면 모드</div>
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        return <button key={option.value} type="button" role="menuitemradio" aria-checked={preference === option.value} className={preference === option.value ? "active" : ""} onClick={() => select(option.value)}>
          <span><Icon size={17}/>{option.label}</span>
          {preference === option.value && <Check size={17}/>} 
        </button>;
      })}
    </div>}
    <button type="button" className="theme-trigger" aria-label="화면 모드 변경" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <CurrentIcon size={18}/><span>{OPTIONS.find((option) => option.value === preference)?.label ?? "시스템"}</span>
    </button>
  </div>;
}
