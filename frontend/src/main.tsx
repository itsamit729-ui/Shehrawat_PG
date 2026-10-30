import React, { Suspense, lazy, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
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
function ScrollReset() {
  const location = useLocation();
  React.useEffect(() => {
    window.scrollTo(0, 0);
    document.title =
      (location.pathname === "/"
        ? "A little closer to home"
        : location.pathname
            .split("/")
            .filter(Boolean)
            .at(-1)
            ?.replaceAll("-", " ") || "Home") + " · Sehrawat PG";
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
            <Route path="/index.html" element={<Navigate to="/" replace />} />
            <Route
              path="/explore.html"
              element={<Navigate to="/explore" replace />}
            />
            <Route
              path="/owner-dashboard.html"
              element={<Navigate to="/owner/overview" replace />}
            />
            <Route
              path="/resident.html"
              element={<Navigate to="/resident/home" replace />}
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
