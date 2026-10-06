"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, CHANGED } from "@/lib/client";

export const THEME_KEY = "lume-licence-theme";
type Theme = "light" | "dark";

const ICON: Record<string, ReactNode> = {
  clients: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M2 6.5h12M6 6.5v7" />
    </>
  ),
  analytics: <path d="M2 13.5h12M3.5 10.5l3-3.5 2.5 2 4-5" />,
  enquiries: <path d="M2 4.5h12v8H2zM2 4.5l6 4.5 6-4.5" />,
  releases: <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11" />,
  payments: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M1.5 6.5h13M4.5 10h2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
};
const NAV = [
  ["clients", "Clients"],
  ["enquiries", "Enquiries"],
  ["analytics", "Analytics"],
  ["releases", "Releases"],
  ["payments", "Payments"],
  ["settings", "Settings"],
] as const;

/** Light and dark (Porcelain and Carbon), at the foot of the sidebar, remembered on this browser. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    // Every open tab follows a switch made in another.
    const onStore = (e: StorageEvent) => {
      if (e.key === THEME_KEY && (e.newValue === "light" || e.newValue === "dark")) apply(e.newValue, false);
    };
    window.addEventListener("storage", onStore);
    return () => window.removeEventListener("storage", onStore);
  }, []);
  function apply(t: Theme, remember = true) {
    document.documentElement.dataset.theme = t;
    setTheme(t);
    if (remember)
      try {
        localStorage.setItem(THEME_KEY, t);
      } catch {
        /* private browsing: the switch still works for this visit */
      }
  }
  return (
    <div className="theme" role="radiogroup" aria-label="Appearance">
      <span className="knob" aria-hidden />
      <button type="button" role="radio" aria-checked={theme === "light"} onClick={() => apply("light")}>
        <svg
          className="sun"
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
        </svg>
        Light
      </button>
      <button type="button" role="radio" aria-checked={theme === "dark"} onClick={() => apply("dark")}>
        <svg
          className="moon"
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M13.5 9.5A5.5 5.5 0 016.5 2.5a5.5 5.5 0 107 7z" />
        </svg>
        Dark
      </button>
    </div>
  );
}

/** The sidebar and the sheet every screen sits on (canvas: the admin screens' shell). */
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  // How many enquiries are still new, beside Enquiries in the sidebar (website spec §7).
  const [newCount, setNewCount] = useState(0);
  useEffect(() => {
    const load = () =>
      void api
        .get<{ newCount: number }>("/api/enquiries?status=new")
        .then((r) => r.ok && setNewCount(r.data.newCount));
    load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, []);
  const signOut = async () => {
    await api.post("/api/auth/sign-out");
    router.push("/sign-in");
  };
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <img src="/lume-mark.png" alt="" />
          <div>
            <b>LUME Licences</b>
            <small>license.lumecrm.in</small>
          </div>
        </div>
        <nav className="navs" aria-label="Licence server">
          {NAV.map(([key, label]) => (
            <Link
              key={key}
              className="nav"
              href={`/${key}`}
              aria-current={path.startsWith(`/${key}`) ? "page" : undefined}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                {ICON[key]}
              </svg>
              {label}
              {key === "enquiries" && newCount > 0 && (
                <span className="badge-soft" aria-label={`${newCount} new`} style={{ marginLeft: "auto" }}>
                  {newCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <ThemeSwitch />
        <button type="button" className="signout" onClick={() => void signOut()}>
          Sign out
        </button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

/** A screen's heading, with the bell and the screen's own actions. */
export function Head({
  title,
  sub,
  back,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  back?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="head">
      <div className="titles">
        {back}
        {typeof title === "string" ? <h1>{title}</h1> : title}
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="acts">{children}</div>
    </header>
  );
}
