import { useState } from "react";
import { Plus } from "lucide-react";
import { useApp } from "./state";
import { Panel, FormModal, Table, Badge, Fields, Alert } from "./components";
import { money } from "./domain";
export function RefundRequests() {
  const { data, action } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="Refund requests"
      description="Refunds require verification against a captured payment. Only the provider can confirm completion."
      action={
        <button className="btn secondary compact" onClick={() => setOpen(true)}>
          <Plus size={15} />
          Request refund
        </button>
      }
    >
      <Table
        rows={data.requests.filter((r) => r.type === "refunds")}
        columns={[
          { label: "Payment reference", key: "paymentId" },
          {
            label: "Amount",
            key: "amount",
            render: (r) => money(Number(r.amount)),
          },
          { label: "Reason", key: "reason" },
          {
            label: "Status",
            key: "status",
            render: (r) => <Badge>{String(r.status)}</Badge>,
          },
        ]}
      />
      {open && (
        <FormModal
          title="Request a refund"
          description="The backend must verify refundable balance and ownership. This action does not immediately mark the payment refunded."
          fields={[
            {
              name: "paymentId",
              label: "Captured payment reference",
              required: true,
            },
            {
              name: "amount",
              label: "Refund amount (₹)",
              type: "number",
              min: 1,
              required: true,
            },
            {
              name: "reason",
              label: "Reason for refund",
              type: "textarea",
              required: true,
            },
            {
              name: "confirm",
              label: "Type REFUND to confirm",
              required: true,
            },
          ]}
          submit="Submit refund request"
          onClose={() => setOpen(false)}
          onSubmit={async (v) => {
            if (v.confirm !== "REFUND")
              throw new Error("Type REFUND to confirm the request.");
            await action("refunds", {
              paymentId: v.paymentId,
              amount: Number(v.amount),
              reason: v.reason,
            });
          }}
        />
      )}
    </Panel>
  );
}
export function MealSettings() {
  const { data, action } = useApp();
  const [day, setDay] = useState("0");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const menu = (data.settings.mealMenu || {}) as Record<
    string,
    Record<string, string>
  >;
  return (
    <Panel
      title="Weekly meal menu"
      description="Publish breakfast, lunch and dinner for each day."
    >
      <label className="field">
        <span>Day</span>
        <select value={day} onChange={(e) => setDay(e.target.value)}>
          {[
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ].map((label, i) => (
            <option key={i} value={i}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <form
        key={day}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const v = Object.fromEntries(new FormData(e.currentTarget));
          try {
            await action("settings", { mealMenu: { ...menu, [day]: v } });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Fields
          fields={["breakfast", "lunch", "dinner"].map((name) => ({
            name,
            label: name[0].toUpperCase() + name.slice(1),
            required: true,
          }))}
          defaults={menu[day] || {}}
        />
        {error && <Alert>{error}</Alert>}
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Publish menu"}
        </button>
      </form>
    </Panel>
  );
}
