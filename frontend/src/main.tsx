import React, { Suspense, lazy, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useSearchParams,
  Link,
} from "react-router-dom";
import { AppProvider, useApp } from "./state";
import { PortalLayout, Loading, Alert, Empty } from "./components";
import {
  HomePage,
  ExplorePage,
  PropertyPage,
  BookingPage,
  LoginPage,
  RecoveryPage,
  InfoPage,
  NotFound,
} from "./public";
import type { Role } from "./domain";
import "./styles.css";
import "./premium.css";
import { PaymentStatus, SetPassword } from "./account";
const Owner = lazy(() =>
  import("./portals").then((m) => ({ default: m.OwnerPortal })),
);
const Resident = lazy(() =>
  import("./portals").then((m) => ({ default: m.ResidentPortal })),
);
const Corporate = lazy(() =>
  import("./portals").then((m) => ({ default: m.CorporatePortal })),
);
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="fatal">
        <h1>Something didn’t load.</h1>
        <p>Please reload the page to try again.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
function ScrollReset() {
  const location = useLocation();
  React.useEffect(() => {
    window.scrollTo(0, 0);
    document.title =
      (location.pathname === "/"
        ? "A little closer to home"
        : location.pathname
            .split("/")
            .filter((part) => part && !RECORD_ID.test(part))
            .at(-1)
            ?.replaceAll("-", " ") || "Home") + " · Shehrawat PG";
  }, [location.pathname]);
  return null;
}
function Protected({ role, children }: { role: Role; children: ReactNode }) {
  const { session, loading, error, refresh } = useApp();
  const location = useLocation();
  if (loading) return <Loading />;
  if (error)
    return (
      <div className="container section">
        <Alert>{error}</Alert>
        <button className="btn" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  if (!session)
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (session.role !== role)
    return (
      <Empty
        title="This workspace isn’t assigned to your account."
        action={
          <Link
            className="btn"
            to={`/${session.role}/${session.role === "resident" ? "home" : "overview"}`}
          >
            Open my portal
          </Link>
        }
      />
    );
  return (
    <PortalLayout>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </PortalLayout>
  );
}
/** Old prototype URLs, which may still be bookmarked or shared. */
const LEGACY_PAGES: Record<string, string> = {
  "/index.html": "/",
  "/explore.html": "/explore",
  "/owner-dashboard.html": "/owner/overview",
  "/resident.html": "/resident/home",
  "/about.html": "/about",
  "/corporate.html": "/corporate",
  "/legal.html": "/legal",
  "/partner.html": "/partner",
  "/safety.html": "/safety",
};
function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
function LegacyRecordRedirect({ to, param }: { to: string; param: string }) {
  const [params] = useSearchParams();
  const id = params.get(param);
  return (
    <Navigate
      to={id ? `${to}/${encodeURIComponent(id)}` : "/explore"}
      replace
    />
  );
}
export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppProvider>
          <ScrollReset />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/explore" element={<ExplorePage />} />
            <Route path="/properties/:id" element={<PropertyPage />} />
            <Route path="/book/:id" element={<BookingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/recover" element={<RecoveryPage />} />
            <Route path="/set-password" element={<SetPassword />} />
            <Route path="/payment/status" element={<PaymentStatus />} />
            {(
              ["corporate", "partner", "about", "safety", "legal"] as const
            ).map((kind) => (
              <Route
                key={kind}
                path={"/" + kind}
                element={<InfoPage kind={kind} />}
              />
            ))}
            <Route
              path="/owner"
              element={<Navigate to="/owner/overview" replace />}
            />
            <Route
              path="/owner/:section"
              element={
                <Protected role="owner">
                  <Owner />
                </Protected>
              }
            />
            <Route
              path="/resident"
              element={<Navigate to="/resident/home" replace />}
            />
            <Route
              path="/resident/:section"
              element={
                <Protected role="resident">
                  <Resident />
                </Protected>
              }
            />
            <Route
              path="/corporate/:section"
              element={
                <Protected role="corporate">
                  <Corporate />
                </Protected>
              }
            />
            {Object.entries(LEGACY_PAGES).map(([path, to]) => (
              <Route
                key={path}
                path={path}
                element={<LegacyRedirect to={to} />}
              />
            ))}
            <Route
              path="/property.html"
              element={<LegacyRecordRedirect to="/properties" param="id" />}
            />
            <Route
              path="/book.html"
              element={<LegacyRecordRedirect to="/book" param="property" />}
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
