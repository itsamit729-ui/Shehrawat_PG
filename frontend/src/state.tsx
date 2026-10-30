import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { DEMO, request, resetCsrf, ApiError } from "./api";
import { seed } from "./seed";
import {
  applyReceipt,
  type DataState,
  type Session,
  type Role,
  type Collection,
} from "./domain";
const empty: DataState = {
  beds: [],
  properties: [],
  residents: [],
  invoices: [],
  tickets: [],
  leads: [],
  agreements: [],
  campaigns: [],
  conversations: [],
  expenses: [],
  allocations: [],
  requests: [],
  payments: [],
  settings: {},
};
interface AppContext {
  data: DataState;
  session: Session | null;
  loading: boolean;
  error: string;
  notify: (s: string) => void;
  refresh: () => Promise<void>;
  loginDemo: (role: Role) => void;
  login: (payload: unknown) => Promise<void>;
  logout: () => Promise<void>;
  save: (c: Collection, value: Record<string, unknown>) => Promise<void>;
  action: (name: string, payload: Record<string, unknown>) => Promise<unknown>;
  reset: () => void;
  sync: (collection: Collection) => Promise<void>;
}
const REFRESH_FAILED =
  "Saved, but the latest data couldn’t be loaded. Please reload the page.";
const Context = createContext<AppContext>(null!);
export function useApp() {
  return useContext(Context);
}
export function usePolling(collection: Collection, delay: number) {
  const { sync } = useApp();
  useEffect(() => {
    if (DEMO) return;
    let inFlight = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      try {
        await sync(collection);
      } catch {
        /* Next poll retries; user mutations still surface failures. */
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(tick, delay);
    return () => clearInterval(timer);
  }, [collection, delay, sync]);
}
export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DataState>(() => (DEMO ? seed() : empty));
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!DEMO);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const latestLoad = useRef(0);
  const notify = (s: string) => setToast(s);
  /** Signs out locally on a 401, so route guards send the user to log in. Always rethrows. */
  const signOutIfExpired = useCallback((e: unknown): never => {
    if (e instanceof ApiError && e.status === 401) {
      resetCsrf();
      setSession(null);
      setData((old) => ({ ...empty, properties: old.properties }));
      setToast("Your session has ended. Please sign in again.");
    }
    throw e;
  }, []);
  const sync = useCallback(
    async (collection: Collection) => {
      if (DEMO) return;
      const records = await request<DataState[Collection]>(
        "/" + collection,
      ).catch(signOutIfExpired);
      setData((old) => ({ ...old, [collection]: records }));
    },
    [signOutIfExpired],
  );
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  /**
   * A background load follows a save: the current screen and its filters, dialogs and selections
   * stay mounted, and a failure leaves the data on screen. Responses to older loads are discarded.
   */
  async function load(background = false) {
    if (DEMO) return true;
    const run = ++latestLoad.current;
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      const properties = await request<DataState["properties"]>("/properties");
      if (!background && run === latestLoad.current)
        setData({ ...empty, properties });
      let me: Session | null = null;
      try {
        me = await request<Session>("/auth/session");
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
      }
      const scoped = me ? await request<Partial<DataState>>("/portal") : {};
      if (run !== latestLoad.current) return true;
      setSession(me);
      setData({ ...empty, ...scoped, properties });
      return true;
    } catch (e) {
      if (run !== latestLoad.current) return true;
      if (e instanceof ApiError && e.status === 401) {
        try {
          signOutIfExpired(e);
        } catch {
          /* Being signed out is the outcome here, not a failure to report. */
        }
        return true;
      }
      if (!background) setError((e as Error).message);
      return false;
    } finally {
      if (run === latestLoad.current) setLoading(false);
    }
  }
  async function refresh() {
    await load();
  }
  useEffect(() => {
    void load();
  }, []);
  function loginDemo(role: Role) {
    if (!DEMO) return;
    setSession({
      id: "demo-" + role,
      name:
        role === "owner"
          ? "Amit"
          : role === "resident"
            ? "Rohit Kulkarni"
            : "Acme Technologies",
      role,
      residentId: role === "resident" ? "R1001" : undefined,
      corporateId: role === "corporate" ? "C001" : undefined,
    });
  }
  async function login(payload: unknown) {
    const result = await request<{ user: Session }>("/auth/login", {
      method: "POST",
      body: payload,
    });
    setSession(result.user);
    await load();
  }
  async function logout() {
    if (!DEMO) await request("/auth/logout", { method: "POST" });
    // A load still in flight must not sign this user back in when it finishes.
    latestLoad.current++;
    setLoading(false);
    resetCsrf();
    setSession(null);
    if (!DEMO) setData({ ...empty, properties: data.properties });
  }
  async function save(collection: Collection, value: Record<string, unknown>) {
    if (!DEMO) {
      await request(
        "/" +
          collection +
          (value.id ? "/" + encodeURIComponent(String(value.id)) : ""),
        {
          method: value.id ? "PATCH" : "POST",
          body: value,
          key: crypto.randomUUID(),
        },
      ).catch(signOutIfExpired);
      notify((await load(true)) ? "Changes saved." : REFRESH_FAILED);
      return;
    }
    const row = { ...value, id: value.id || crypto.randomUUID() };
    setData((old) => ({
      ...old,
      [collection]: value.id
        ? (old[collection] as { id: string }[]).map((x) =>
            x.id === value.id ? { ...x, ...row } : x,
          )
        : [row, ...old[collection]],
    }));
    notify("Saved in this preview.");
  }
  async function action(name: string, payload: Record<string, unknown>) {
    if (!DEMO) {
      const result = await request("/" + name, {
        method: "POST",
        body: payload,
        key: crypto.randomUUID(),
      }).catch(signOutIfExpired);
      notify((await load(true)) ? "Request submitted." : REFRESH_FAILED);
      return result;
    }
    if (name === "payments/manual") {
      const invoice = data.invoices.find((i) => i.id === payload.invoiceId);
      if (!invoice) throw new Error("Invoice not found.");
      const updated = applyReceipt(invoice, Number(payload.amount));
      setData((old) => ({
        ...old,
        invoices: old.invoices.map((i) => (i.id === invoice.id ? updated : i)),
        payments: [
          {
            id: crypto.randomUUID(),
            ...payload,
            created: new Date().toISOString(),
          },
          ...old.payments,
        ],
      }));
    } else if (name === "messages/send") {
      setData((old) => ({
        ...old,
        conversations: old.conversations.map((c) =>
          c.id === payload.conversationId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    id: crypto.randomUUID(),
                    body: String(payload.body),
                    sender: "staff",
                    time: new Date().toISOString(),
                    status: "Preview",
                  },
                ],
              }
            : c,
        ),
      }));
    } else if (name === "settings") {
      setData((old) => ({ ...old, settings: { ...old.settings, ...payload } }));
    } else if (name === "campaigns/schedule") {
      setData((old) => ({
        ...old,
        campaigns: old.campaigns.map((c) =>
          c.id === payload.id ? { ...c, status: "Scheduled" } : c,
        ),
      }));
    } else {
      setData((old) => ({
        ...old,
        requests: [
          {
            id: crypto.randomUUID(),
            type: name,
            ...payload,
            created: new Date().toISOString(),
            status: "Requested",
          },
          ...old.requests,
        ],
      }));
    }
    notify("Saved in preview only. No payment, message or document was sent.");
    return { status: "preview" };
  }
  return (
    <Context.Provider
      value={{
        data,
        session,
        loading,
        error,
        notify,
        refresh,
        sync,
        loginDemo,
        login,
        logout,
        save,
        action,
        reset: () => {
          if (!DEMO) return;
          setData(seed());
          notify("Sample data reset.");
        },
      }}
    >
      {children}
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
