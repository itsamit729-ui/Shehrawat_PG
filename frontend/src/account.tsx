import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, Clock, Upload, ArrowRight } from "lucide-react";
import { DEMO, request } from "./api";
import {
  PublicLayout,
  Panel,
  PageHead,
  Alert,
  Fields,
  Loading,
} from "./components";
import { safeExternalUrl } from "./domain";
export function PaymentStatus() {
  const [params] = useSearchParams();
  const orderId = params.get("order_id");
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (DEMO || !orderId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;
    const controller = new AbortController();
    async function poll() {
      try {
        const result = await request<{ status: string }>(
          "/payments/status?orderId=" + encodeURIComponent(orderId!),
          { signal: controller.signal },
        );
        if (stopped) return;
        setStatus(result.status);
        setError("");
        if (["pending", "processing"].includes(result.status) && ++tries < 12)
          timer = setTimeout(poll, 5000);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [orderId, attempt]);
  const paid = status === "confirmed";
  return (
    <PublicLayout>
      <section className="container section narrow">
        <Panel>
          <div className="success">
            {paid ? <Check size={40} /> : <Clock size={40} />}
            <h1 style={{ fontSize: 30 }}>
              {paid
                ? "Payment verified"
                : status === "failed"
                  ? "Payment not completed"
                  : status === "review"
                    ? "Payment needs review"
                    : "Checking your payment"}
            </h1>
            <p>
              {DEMO
                ? "This is a payment status preview. No live payment has been made."
                : !orderId
                  ? "A valid order reference is required."
                  : paid
                    ? "Your payment has been verified by the service. Check your portal for the booking and receipt."
                    : status === "review"
                      ? "Your payment needs a review before a bed can be confirmed. Please contact the property team."
                      : "Please do not make another payment while this transaction is being checked."}
            </p>
            {error && <Alert>{error}</Alert>}
            {!DEMO && orderId && !paid && (
              <button
                className="btn secondary"
                onClick={() => setAttempt((a) => a + 1)}
              >
                Check again
              </button>
            )}
            <Link className="btn" to="/login">
              Open my portal <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      </section>
    </PublicLayout>
  );
}
export function SetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  return (
    <PublicLayout>
      <section className="container section narrow">
        <PageHead
          title="Make this space yours."
          description="Set a password for your invited account or recovery request."
        />
        <Panel>
          {done ? (
            <div className="success">
              <Check size={32} />
              <h3>Password updated.</h3>
              <Link to="/login" className="btn">
                Sign in
              </Link>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                const values = Object.fromEntries(
                  new FormData(e.currentTarget),
                );
                try {
                  if (String(values.password).length < 12)
                    throw new Error("Use at least 12 characters.");
                  if (values.password !== values.confirm)
                    throw new Error("The passwords do not match.");
                  if (!token && !DEMO)
                    throw new Error(
                      "Open the full link from your invitation or recovery message.",
                    );
                  if (!DEMO)
                    await request("/auth/set-password", {
                      method: "POST",
                      body: { token, password: values.password },
                    });
                  setDone(true);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Fields
                fields={[
                  {
                    name: "password",
                    label: "New password (12+ characters)",
                    type: "password",
                    required: true,
                  },
                  {
                    name: "confirm",
                    label: "Confirm password",
                    type: "password",
                    required: true,
                  },
                ]}
              />
              {error && <Alert>{error}</Alert>}
              <button className="btn" disabled={busy}>
                {busy ? "Updating…" : "Set password"}
              </button>
            </form>
          )}
        </Panel>
      </section>
    </PublicLayout>
  );
}
export function DocumentUpload() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  return (
    <Panel
      title="Upload a requested document"
      description="Only upload documents your property team has asked for."
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const file = new FormData(form).get("document") as File;
          if (!file?.size) {
            setError("Choose a file.");
            return;
          }
          if (
            !["application/pdf", "image/jpeg", "image/png"].includes(
              file.type,
            ) ||
            file.size > 5 * 1024 * 1024
          ) {
            setError("Choose a PDF, JPEG or PNG up to 5 MB.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            if (!DEMO) {
              const upload = await request<{ id: string; uploadUrl: string }>(
                "/uploads",
                {
                  method: "POST",
                  body: {
                    fileName: file.name,
                    contentType: file.type,
                    size: file.size,
                    purpose: "resident-document",
                  },
                },
              );
              const url = safeExternalUrl(upload.uploadUrl);
              if (!url)
                throw new Error("The upload link could not be verified.");
              const response = await fetch(url, {
                method: "PUT",
                body: file,
                headers: { "Content-Type": file.type },
              });
              if (!response.ok)
                throw new Error("Upload failed. Please try again.");
              await request(
                "/uploads/" + encodeURIComponent(upload.id) + "/complete",
                { method: "POST" },
              );
            }
            setDone(true);
            form.reset();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>PDF, JPEG or PNG · maximum 5 MB</span>
          <input
            name="document"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            required
          />
        </label>
        {error && <Alert>{error}</Alert>}
        {done && (
          <p role="status">
            {DEMO
              ? "Preview validated. No file was uploaded or stored."
              : "Document uploaded. Validation is pending."}
          </p>
        )}
        <button
          className="btn secondary"
          style={{ marginTop: 15 }}
          disabled={busy}
        >
          {busy ? "Uploading…" : "Upload document"}
          <Upload size={16} />
        </button>
      </form>
    </Panel>
  );
}
