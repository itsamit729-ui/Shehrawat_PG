import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Home,
  Menu,
  Search,
  X,
  LogOut,
  LayoutDashboard,
  Users,
  Wallet,
  Building2,
  MessageSquare,
  Megaphone,
  FileSignature,
  Settings,
  ChartNoAxesCombined,
  Wrench,
  CalendarDays,
  Utensils,
  Gift,
  DoorOpen,
  ShieldCheck,
  Building,
  Download,
  RefreshCw,
  Moon,
  Sun,
} from "lucide-react";
import { DEMO } from "./api";
import { useApp } from "./state";
import { downloadCSV, type Role } from "./domain";

/** A lightweight, accessible appearance control shared across public and portal screens. */
export function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    try {
      return window.localStorage.getItem("sehrawat-theme") === "dark";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      window.localStorage.setItem("sehrawat-theme", dark ? "dark" : "light");
    } catch {
      // Storage can be unavailable in privacy-restricted browsers.
    }
  }, [dark]);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
      aria-pressed={dark}
      onClick={() => setDark((value) => !value)}
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
      <span>{dark ? "Light" : "Dark"}</span>
    </button>
  );
}

export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Sehrawat PG home">
      <span className="brand-icon">
        <Home size={21} />
      </span>
      <span>
        sehrawat<span className="brand-small">PG & CO-LIVING</span>
      </span>
    </Link>
  );
}
export function Notice() {
  return DEMO ? (
    <div className="preview-notice">
      <span>
        <b>Frontend preview</b> · Sample listings and data. No real bookings or
        messages.
      </span>
      <Link to="/login">
        Explore portals <ArrowUpRight size={13} />
      </Link>
    </div>
  ) : null;
}
export function PublicLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [open]);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Notice />
      <header className="site-header">
        <div className="container header-row">
          <Brand />
          <button
            className="icon-button mobile-menu"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-controls="public-main-nav"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <X /> : <Menu />}
          </button>
          <nav
            id="public-main-nav"
            className={open ? "public-nav open" : "public-nav"}
            aria-label="Main navigation"
          >
            <NavLink to="/explore">Find a home</NavLink>
            <NavLink to="/corporate">For companies</NavLink>
            <NavLink to="/partner">Partner with us</NavLink>
            <NavLink to="/about">Our story</NavLink>
            <ThemeToggle />
            <Link className="nav-login" to="/login">
              Sign in <ArrowUpRight size={16} />
            </Link>
          </nav>
        </div>
      </header>
      {open && (
        <button
          type="button"
          className="public-nav-backdrop"
          aria-label="Close navigation menu"
          onClick={() => setOpen(false)}
        />
      )}
      <main id="main">{children}</main>
      <footer className="footer">
        <div className="container footer-grid">
          <div>
            <Brand />
            <p>
              A space of your own.
              <br />A community to come home to.
            </p>
          </div>
          <div>
            <b>Find your place</b>
            <Link to="/explore">Explore residences</Link>
            <Link to="/corporate">Corporate housing</Link>
            <Link to="/partner">List your property</Link>
          </div>
          <div>
            <b>Life at Sehrawat</b>
            <Link to="/about">Our story</Link>
            <Link to="/safety">Safety & care</Link>
            <Link to="/login">Resident portal</Link>
          </div>
          <div>
            <b>Good to know</b>
            <Link to="/legal">Terms & privacy</Link>
            <Link to="/explore">Schedule a visit</Link>
            <span>Gurugram, Haryana</span>
          </div>
        </div>
        <div className="container footer-bottom">
          © {new Date().getFullYear()} Sehrawat PG{" "}
          <span>Made for everyday living.</span>
        </div>
      </footer>
    </>
  );
}
export const navs: Record<Role, [string, string, typeof Home][]> = {
  owner: [
    ["overview", "Overview", LayoutDashboard],
    ["residents", "Residents", Users],
    ["inventory", "Rooms & beds", Building2],
    ["rent", "Rent & payments", Wallet],
    ["insights", "Resident insights", ChartNoAxesCombined],
    ["leads", "Leads & visits", CalendarDays],
    ["complaints", "Complaints", Wrench],
    ["inbox", "Shared inbox", MessageSquare],
    ["campaigns", "Campaigns", Megaphone],
    ["automation", "Automated messages", RefreshCw],
    ["agreements", "Agreements", FileSignature],
    ["finance", "Financial reports", ChartNoAxesCombined],
    ["properties", "Properties", Building],
    ["settings", "Settings", Settings],
  ],
  resident: [
    ["home", "My home", Home],
    ["rent", "Rent & bills", Wallet],
    ["complaints", "Help & complaints", Wrench],
    ["food", "Food menu", Utensils],
    ["agreements", "My documents", FileSignature],
    ["refer", "Refer a friend", Gift],
    ["move-out", "Move out", DoorOpen],
  ],
  corporate: [
    ["overview", "Overview", LayoutDashboard],
    ["employees", "Employees & beds", Users],
    ["invoices", "Company invoices", Wallet],
    ["requests", "Housing requests", Building2],
    ["agreements", "Agreements", FileSignature],
  ],
};
export function PortalLayout({ children }: { children: ReactNode }) {
  const { session, logout } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!session) return null;
  const links = navs[session.role];
  return (
    <div className="app-shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className={open ? "sidebar open" : "sidebar"}>
        <Brand />
        <div className="workspace-name">
          <span className="avatar small">{session.name[0]}</span>
          <div>
            <b>
              {session.role === "owner" ? "Sehrawat workspace" : session.name}
            </b>
            <small>{session.role} portal</small>
          </div>
        </div>
        <nav aria-label="Portal navigation">
          {links.map(([path, label, Icon]) => (
            <NavLink key={path} to={`/${session.role}/${path}`}>
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ShieldCheck size={17} />
          <span>Your home, well managed.</span>
        </div>
      </aside>
      {open && (
        <button
          className="nav-overlay"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <div className="portal-body">
        <Notice />
        <header className="app-header">
          <button
            className="icon-button mobile-menu"
            aria-label={open ? "Close portal navigation" : "Open portal navigation"}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            {links.find(([p]) => loc.pathname.endsWith(p))?.[1] || "Overview"}
          </div>
          <div className="header-actions">
            <ThemeToggle />
            <Link to="/explore" className="text-link">
              View website <ArrowUpRight size={14} />
            </Link>
            <span className="avatar small">
              {session.name.slice(0, 2).toUpperCase()}
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await logout();
                  navigate("/login");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="portal-main" id="main">
          {error && <Alert>{error}</Alert>}
          {children}
        </main>
      </div>
    </div>
  );
}
export function PageHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      {children}
    </div>
  );
}
export function Empty({
  title = "Nothing here yet",
  text = "New records will appear here.",
  action,
}: {
  title?: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Building2 size={30} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      Loading your workspace…
    </div>
  );
}
export function Badge({ children }: { children: ReactNode }) {
  const s = String(children);
  const good = /Paid|Active|Signed|Resolved|Delivered|Available|Confirmed/.test(
    s,
  );
  const bad = /Overdue|Cancelled|High|Failed|Refund/.test(s);
  return (
    <span className={`badge ${good ? "good" : bad ? "bad" : "warm"}`}>
      {children}
    </span>
  );
}
export function Stats({
  items,
}: {
  items: {
    label: string;
    value: ReactNode;
    detail?: string;
    icon?: typeof Home;
  }[];
}) {
  return (
    <div className="stats">
      {items.map(
        ({ label, value, detail, icon: Icon = ChartNoAxesCombined }) => (
          <div className="stat" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={18} />
            </div>
            <strong>{value}</strong>
            <small>{detail || "Current period"}</small>
          </div>
        ),
      )}
    </div>
  );
}
export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"panel " + className}>
      {title && (
        <div className="panel-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export type Field = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: string | number;
  max?: string | number;
  placeholder?: string;
  value?: unknown;
};
export function Fields({
  fields,
  defaults = {},
}: {
  fields: Field[];
  defaults?: Record<string, unknown>;
}) {
  return (
    <div className="form-grid">
      {fields.map((f) => (
        <label
          key={f.name}
          className={f.type === "textarea" ? "field full" : "field"}
        >
          <span>
            {f.label}
            {f.required && " *"}
          </span>
          {f.options ? (
            <select
              name={f.name}
              required={f.required}
              defaultValue={String(defaults[f.name] ?? f.value ?? "")}
            >
              <option value="">Choose an option</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.type === "textarea" ? (
            <textarea
              name={f.name}
              required={f.required}
              maxLength={3000}
              defaultValue={String(defaults[f.name] ?? f.value ?? "")}
              rows={4}
            />
          ) : (
            <input
              name={f.name}
              type={f.type || "text"}
              required={f.required}
              min={f.min}
              max={f.max}
              maxLength={
                f.name === "otp" ? 6 : f.type === "number" ? undefined : 300
              }
              pattern={
                f.name === "otp"
                  ? "[0-9]{6}"
                  : f.type === "tel"
                    ? "[+0-9 ()\\-]{10,18}"
                    : undefined
              }
              inputMode={f.name === "otp" ? "numeric" : undefined}
              placeholder={f.placeholder}
              defaultValue={String(defaults[f.name] ?? f.value ?? "")}
              autoComplete={
                f.type === "password" ? "current-password" : undefined
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}
export function FormModal({
  title,
  description,
  fields,
  defaults,
  onClose,
  onSubmit,
  submit = "Save changes",
}: {
  title: string;
  description?: string;
  fields: Field[];
  defaults?: Record<string, unknown>;
  onClose: () => void;
  onSubmit: (v: Record<string, string>) => Promise<void>;
  submit?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="modal-head">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setBusy(true);
          const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<
            string,
            string
          >;
          try {
            await onSubmit(v);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Fields fields={fields} defaults={defaults} />
        {error && <Alert>{error}</Alert>}
        <div className="modal-actions">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? "Saving…" : submit}
            <Check size={16} />
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function Table<T extends { id: string }>({
  rows,
  columns,
  searchLabel = "Search records",
  exportName,
}: {
  rows: T[];
  columns: { label: string; key: string; render?: (row: T) => ReactNode }[];
  searchLabel?: string;
  exportName?: string;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ key: "", asc: true });
  const filtered = rows
    .filter((r) =>
      Object.values(r).some((v) =>
        String(v).toLowerCase().includes(query.toLowerCase()),
      ),
    )
    .sort((a, b) => {
      if (!sort.key) return 0;
      const x = (a as Record<string, unknown>)[sort.key];
      const y = (b as Record<string, unknown>)[sort.key];
      return (
        (typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""))) *
        (sort.asc ? 1 : -1)
      );
    });
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages - 1);
  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        {exportName && (
          <button
            className="btn secondary compact"
            onClick={() =>
              downloadCSV(exportName, filtered as Record<string, unknown>[])
            }
          >
            <Download size={15} />
            Export CSV
          </button>
        )}
      </div>
      {filtered.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label}>
                    {c.key ? (
                      <button
                        onClick={() =>
                          setSort({
                            key: c.key,
                            asc: sort.key === c.key ? !sort.asc : true,
                          })
                        }
                      >
                        {c.label}
                        {sort.key === c.key ? (sort.asc ? " ↑" : " ↓") : ""}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(current * 8, current * 8 + 8).map((row) => (
                <tr key={row.id}>
                  {columns.map((c) => (
                    <td key={c.label}>
                      {c.render
                        ? c.render(row)
                        : String(
                            (row as Record<string, unknown>)[c.key] ?? "—",
                          )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="No matching records"
          text="Try another search or add your first record."
        />
      )}
      <div className="table-footer">
        <span>
          {filtered.length} records · Page {current + 1} of {pages}
        </span>
        <div>
          <button
            className="icon-button"
            disabled={!current}
            aria-label="Previous page"
            onClick={() => setPage(current - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-button"
            disabled={current + 1 >= pages}
            aria-label="Next page"
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
export function SubmitForm({
  fields,
  submit = "Send enquiry",
  onSubmit,
  success = "Thank you. Your request has been submitted.",
}: {
  fields: Field[];
  submit?: string;
  onSubmit: (v: Record<string, string>) => Promise<void>;
  success?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  if (done)
    return (
      <div className="success">
        <Check size={32} />
        <h3>{success}</h3>
        <p>
          {DEMO
            ? "This was saved in the preview only."
            : "Our team will follow up using your contact details."}
        </p>
        <button className="btn secondary" onClick={() => setDone(false)}>
          Submit another request
        </button>
      </div>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<
          string,
          string
        >;
        try {
          await onSubmit(v);
          setDone(true);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Fields fields={fields} />
      {error && <Alert>{error}</Alert>}
      <p className="form-note">
        By submitting, you agree to be contacted about this request.{" "}
        <Link to="/legal">Privacy information</Link>.
      </p>
      <button className="btn" disabled={busy}>
        {busy ? "Submitting…" : submit}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
