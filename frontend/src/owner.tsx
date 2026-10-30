import { RefundRequests } from "./services";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Plus,
  Users,
  Building2,
  Wallet,
  MessageSquare,
  Send,
  Download,
  Check,
  FileSignature,
  CalendarDays,
  Search,
} from "lucide-react";
import { useApp, usePolling } from "./state";
import { DEMO } from "./api";
import {
  PageHead,
  Stats,
  Panel,
  Table,
  Badge,
  FormModal,
  Empty,
  Alert,
  Fields,
  type Field,
} from "./components";
import {
  money,
  invoiceBalance,
  formatDate,
  today,
  canReply,
  downloadCSV,
  safeExternalUrl,
  type Resident,
  type Invoice,
  type Property,
  type Ticket,
} from "./domain";
const options = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
export function Occupancy() {
  const { data } = useApp();
  return (
    <div className="occupancy-list">
      {data.properties.map((p) => {
        const beds = data.beds.filter((b) => b.propertyId === p.id),
          occupied = beds.filter((b) => b.status === "Occupied").length;
        return (
          <div key={p.id}>
            <div>
              <span>{p.name.replace("Sehrawat ", "")}</span>
              <b>
                {occupied} / {beds.length}
              </b>
            </div>
            <div className="progress">
              <span
                style={{
                  width:
                    (beds.length ? (occupied / beds.length) * 100 : 0) + "%",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
export function OwnerOverview() {
  const { data } = useApp();
  const occupied = data.beds.filter((b) => b.status === "Occupied").length;
  const collected = data.invoices.reduce((s, i) => s + i.paid, 0);
  const due = data.invoices.reduce((s, i) => s + invoiceBalance(i), 0);
  return (
    <>
      <PageHead
        eyebrow="YOUR BUSINESS AT A GLANCE"
        title="A good day starts here."
        description="A clear view of your homes, residents and the work ahead."
        action={
          <Link className="btn" to="/owner/residents">
            <Plus size={17} />
            Manage residents
          </Link>
        }
      />
      <Stats
        items={[
          {
            label: "Occupied beds",
            value: occupied,
            detail: `of ${data.beds.length} total beds`,
            icon: Building2,
          },
          {
            label: "Rent collected",
            value: money(collected),
            detail: "From invoice payment records",
            icon: Wallet,
          },
          {
            label: "Outstanding rent",
            value: money(due),
            detail: "Unpaid and partially paid invoices",
            icon: Wallet,
          },
          {
            label: "Open requests",
            value: data.tickets.filter((t) => t.status !== "Resolved").length,
            detail: "Resident support tickets",
            icon: MessageSquare,
          },
        ]}
      />
      <div className="dashboard-grid">
        <Panel
          title="A place for everyone"
          description="Occupancy across your properties"
          action={
            <Link className="text-link" to="/owner/inventory">
              View beds <ArrowUpRight size={16} />
            </Link>
          }
        >
          <Occupancy />
        </Panel>
        <Panel
          title="Needs your attention"
          description="Keep the everyday things moving"
        >
          <div className="attention-list">
            {[
              [
                `${data.invoices.filter((i) => invoiceBalance(i) > 0).length} invoices need follow-up`,
                "Review balances and record receipts.",
                "rent",
              ],
              [
                `${data.tickets.filter((t) => t.status !== "Resolved").length} resident requests`,
                "Assign work and keep residents updated.",
                "complaints",
              ],
              [
                `${data.leads.filter((l) => l.status === "New").length} new enquiries`,
                "Help someone find their next home.",
                "leads",
              ],
            ].map(([t, d, path]) => (
              <Link key={path} to={"/owner/" + path}>
                <span className="attention-icon">
                  <ArrowUpRight size={20} />
                </span>
                <div>
                  <b>{t}</b>
                  <p>{d}</p>
                </div>
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        </Panel>
      </div>
      <Panel
        title="Recent residents"
        description="Your community, growing one move-in at a time"
        action={
          <Link to="/owner/residents" className="text-link">
            All residents <ArrowRight size={16} />
          </Link>
        }
      >
        <Table
          rows={data.residents.slice(0, 5)}
          columns={[
            {
              label: "Resident",
              key: "name",
              render: (r) => <Person name={r.name} detail={r.email} />,
            },
            {
              label: "Home",
              key: "propertyId",
              render: (r) =>
                data.properties.find((p) => p.id === r.propertyId)?.name,
            },
            { label: "Room", key: "room" },
            {
              label: "Monthly rent",
              key: "rent",
              render: (r) => money(r.rent),
            },
            {
              label: "Status",
              key: "status",
              render: (r) => <Badge>{r.status}</Badge>,
            },
          ]}
        />
      </Panel>
    </>
  );
}
function Person({ name, detail }: { name: string; detail?: string }) {
  return (
    <div className="person">
      <span className="avatar">
        {name
          .split(" ")
          .map((s) => s[0])
          .slice(0, 2)
          .join("")}
      </span>
      <div>
        <b>{name}</b>
        {detail && <small>{detail}</small>}
      </div>
    </div>
  );
}
export function Residents() {
  const { data, save } = useApp();
  const [edit, setEdit] = useState<Resident | true | null>(null);
  const [status, setStatus] = useState("");
  const fields: Field[] = [
    { name: "name", label: "Full name", required: true },
    { name: "email", label: "Email address", type: "email", required: true },
    { name: "phone", label: "Phone", type: "tel", required: true },
    {
      name: "propertyId",
      label: "Property",
      required: true,
      options: data.properties.map((p) => ({ value: p.id, label: p.name })),
    },
    { name: "room", label: "Room / bed label", required: true },
    {
      name: "rent",
      label: "Monthly rent (₹)",
      type: "number",
      min: 1,
      required: true,
    },
    {
      name: "joined",
      label: "Move-in date",
      type: "date",
      required: true,
      value: today(),
    },
    {
      name: "status",
      label: "Status",
      required: true,
      options: options(["Active", "Notice", "Moved out"]),
      value: "Active",
    },
  ];
  return (
    <>
      <PageHead
        title="People make a place."
        description="Manage resident profiles, stay details and account information."
        action={
          <button className="btn" onClick={() => setEdit(true)}>
            <Plus size={17} />
            Add resident
          </button>
        }
      />
      <div className="tabs">
        {["", "Active", "Notice", "Moved out"].map((s) => (
          <button
            key={s}
            className={status === s ? "active" : ""}
            onClick={() => setStatus(s)}
          >
            {s || "All residents"}
          </button>
        ))}
      </div>
      <Panel>
        <Table
          rows={data.residents.filter((r) => !status || r.status === status)}
          exportName="residents.csv"
          searchLabel="Search name, email or room"
          columns={[
            {
              label: "Resident",
              key: "name",
              render: (r) => <Person name={r.name} detail={r.email} />,
            },
            {
              label: "Property",
              key: "propertyId",
              render: (r) =>
                data.properties
                  .find((p) => p.id === r.propertyId)
                  ?.name.replace("Sehrawat ", ""),
            },
            { label: "Room", key: "room" },
            { label: "Rent", key: "rent", render: (r) => money(r.rent) },
            {
              label: "Status",
              key: "status",
              render: (r) => <Badge>{r.status}</Badge>,
            },
            {
              label: "Actions",
              key: "",
              render: (r) => (
                <button className="text-link" onClick={() => setEdit(r)}>
                  View / edit <ArrowUpRight size={14} />
                </button>
              ),
            },
          ]}
        />
      </Panel>
      {edit && (
        <FormModal
          title={edit === true ? "Add a resident" : "Resident details"}
          description="Creating a resident profile does not reserve or allocate a bed."
          fields={fields}
          defaults={edit === true ? {} : { ...edit }}
          onClose={() => setEdit(null)}
          onSubmit={async (v) => {
            await save("residents", {
              ...v,
              rent: Number(v.rent),
              ...(edit !== true ? { id: edit.id } : {}),
            });
          }}
        />
      )}
    </>
  );
}
export function Inventory() {
  usePolling("beds", 15000);
  const { data, save } = useApp();
  const [property, setProperty] = useState(data.properties[0]?.id || "");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedBed = data.beds.find((b) => b.id === selected);
  const beds = data.beds.filter(
    (b) =>
      (!property || b.propertyId === property) &&
      (!filter || b.status === filter),
  );
  return (
    <>
      <PageHead
        title="Every bed, accounted for."
        description="See occupied, available and blocked beds across your residences."
      />
      <div className="filter-bar">
        <label>
          Property
          <select
            value={property}
            onChange={(e) => setProperty(e.target.value)}
          >
            <option value="">All properties</option>
            {data.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All beds</option>
            {["Available", "Occupied", "Held", "Blocked"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <div className="bed-legend">
          <span className="available">Available</span>
          <span className="occupied">Occupied</span>
          <span className="blocked">Blocked</span>
        </div>
      </div>
      <Panel
        title={`${beds.length} beds`}
        description="Select an available bed to block it for maintenance. Existing stays cannot be overwritten."
      >
        <div className="bed-grid">
          {beds.map((b) => (
            <button
              className={"bed " + b.status.toLowerCase()}
              key={b.id}
              onClick={() => setSelected(b.id)}
              aria-label={`Bed ${b.room}, ${b.status}`}
            >
              <Building2 size={20} />
              <b>{b.room}</b>
              <span>{b.status}</span>
            </button>
          ))}
        </div>
        {!beds.length && <Empty />}
      </Panel>
      {selectedBed && (
        <FormModal
          title={`Bed ${selectedBed.room}`}
          description={`${selectedBed.type} sharing · ${selectedBed.status}. Occupied and held beds are read-only here.`}
          fields={[
            {
              name: "status",
              label: "Bed status",
              required: true,
              options: options(
                selectedBed.status === "Available" ||
                  selectedBed.status === "Blocked"
                  ? ["Available", "Blocked"]
                  : [selectedBed.status],
              ),
            },
          ]}
          defaults={{ status: selectedBed.status }}
          onClose={() => setSelected(null)}
          onSubmit={async (v) => {
            if (["Available", "Blocked"].includes(selectedBed.status))
              await save("beds", { id: selectedBed.id, status: v.status });
            else if (v.status !== selectedBed.status)
              throw new Error(
                "This bed cannot be changed while occupied or held.",
              );
          }}
        />
      )}
    </>
  );
}
export function RentTable({
  invoices,
  owner = false,
}: {
  invoices: Invoice[];
  owner?: boolean;
}) {
  const { data, action, notify } = useApp();
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  async function pay(i: Invoice) {
    setBusy(i.id);
    setError("");
    try {
      if (DEMO) {
        notify("Payment preview only. No money has been collected.");
        return;
      }
      const result = (await action("payment-orders", { invoiceId: i.id })) as {
        checkoutUrl: string;
      };
      const u = safeExternalUrl(result.checkoutUrl);
      if (!u) throw new Error("Unable to verify payment link.");
      window.location.assign(u);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      {error && <Alert>{error}</Alert>}
      <Table
        rows={invoices}
        exportName="invoices.csv"
        columns={[
          {
            label: "Invoice",
            key: "id",
            render: (i) => (
              <div>
                <b>{i.id}</b>
                <small className="block muted">{i.period}</small>
              </div>
            ),
          },
          {
            label: "Resident",
            key: "residentId",
            render: (i) =>
              data.residents.find((r) => r.id === i.residentId)?.name ||
              i.residentId,
          },
          { label: "Due date", key: "due", render: (i) => formatDate(i.due) },
          { label: "Total", key: "amount", render: (i) => money(i.amount) },
          {
            label: "Balance",
            key: "paid",
            render: (i) => money(invoiceBalance(i)),
          },
          {
            label: "Status",
            key: "status",
            render: (i) => <Badge>{i.status}</Badge>,
          },
          {
            label: "Action",
            key: "",
            render: (i) =>
              invoiceBalance(i) > 0 ? (
                <button
                  className="text-link"
                  disabled={busy === i.id}
                  onClick={() => (owner ? setSelected(i) : void pay(i))}
                >
                  {owner
                    ? "Record receipt"
                    : busy === i.id
                      ? "Opening…"
                      : "Pay invoice"}
                  <ArrowUpRight size={14} />
                </button>
              ) : (
                <button
                  className="text-link"
                  onClick={() =>
                    downloadCSV(i.id + ".csv", [
                      {
                        invoice: i.id,
                        period: i.period,
                        description: i.description,
                        total: i.amount,
                        paid: i.paid,
                        status: i.status,
                      },
                    ])
                  }
                >
                  Download <Download size={14} />
                </button>
              ),
          },
        ]}
      />
      {selected && (
        <FormModal
          title="Record a verified receipt"
          description={`${selected.id} · ${money(invoiceBalance(selected))} outstanding. This records an already received bank/cash payment.`}
          fields={[
            {
              name: "amount",
              label: "Amount received (₹)",
              type: "number",
              min: 1,
              max: invoiceBalance(selected),
              required: true,
              value: invoiceBalance(selected),
            },
            {
              name: "method",
              label: "Method",
              required: true,
              options: options(["Bank transfer", "UPI", "Cash"]),
            },
            {
              name: "reference",
              label: "Bank / receipt reference",
              required: true,
            },
          ]}
          onClose={() => setSelected(null)}
          onSubmit={async (v) => {
            await action("payments/manual", {
              ...v,
              invoiceId: selected.id,
              amount: Number(v.amount),
            });
          }}
        />
      )}
    </>
  );
}
export function Rent() {
  const { data, save } = useApp();
  const [newInvoice, setNewInvoice] = useState(false);
  return (
    <>
      <PageHead
        title="Keep collections clear."
        description="Invoices, balances and verified payments in one place."
        action={
          <button className="btn" onClick={() => setNewInvoice(true)}>
            <Plus size={17} />
            Create invoice
          </button>
        }
      />
      <Stats
        items={[
          {
            label: "Billed",
            value: money(data.invoices.reduce((s, i) => s + i.amount, 0)),
          },
          {
            label: "Collected",
            value: money(data.invoices.reduce((s, i) => s + i.paid, 0)),
          },
          {
            label: "Outstanding",
            value: money(
              data.invoices.reduce((s, i) => s + invoiceBalance(i), 0),
            ),
          },
          {
            label: "Paid invoices",
            value: data.invoices.filter((i) => i.status === "Paid").length,
          },
        ]}
      />
      <Panel>
        <RentTable invoices={data.invoices} owner />
      </Panel>
      <RefundRequests />
      {newInvoice && (
        <FormModal
          title="Create an invoice"
          fields={[
            {
              name: "residentId",
              label: "Resident",
              required: true,
              options: data.residents.map((r) => ({
                value: r.id,
                label: r.name,
              })),
            },
            {
              name: "period",
              label: "Billing period",
              type: "month",
              required: true,
              value: today().slice(0, 7),
            },
            { name: "due", label: "Due date", type: "date", required: true },
            {
              name: "amount",
              label: "Total (₹)",
              type: "number",
              min: 1,
              required: true,
            },
            { name: "description", label: "Description", required: true },
          ]}
          onClose={() => setNewInvoice(false)}
          onSubmit={async (v) => {
            if (
              data.invoices.some(
                (i) =>
                  i.residentId === v.residentId &&
                  i.period === v.period &&
                  i.description === v.description,
              )
            )
              throw new Error(
                "This invoice already exists for the billing period.",
              );
            await save("invoices", {
              ...v,
              amount: Number(v.amount),
              paid: 0,
              status: "Due",
            });
          }}
        />
      )}
    </>
  );
}
export function Complaints({ resident = false }: { resident?: boolean }) {
  const { data, session, save } = useApp();
  const [edit, setEdit] = useState<Ticket | true | null>(null);
  const rows = data.tickets.filter(
    (t) => !resident || t.residentId === session?.residentId,
  );
  return (
    <>
      <PageHead
        title={
          resident ? "Let’s make it right." : "A little help goes a long way."
        }
        description="Raise, assign and follow resident requests through to resolution."
        action={
          <button className="btn" onClick={() => setEdit(true)}>
            <Plus size={17} />
            New request
          </button>
        }
      />
      <div className="kanban">
        {["Open", "In progress", "Resolved"].map((status) => (
          <section key={status}>
            <div className="kanban-title">
              <h2>{status}</h2>
              <span>{rows.filter((t) => t.status === status).length}</span>
            </div>
            {rows
              .filter((t) => t.status === status)
              .map((t) => (
                <button
                  className="ticket-card"
                  key={t.id}
                  onClick={() => setEdit(t)}
                >
                  <div>
                    <Badge>{t.priority}</Badge>
                    <span className="muted">{t.id.slice(0, 8)}</span>
                  </div>
                  <h3>{t.subject}</h3>
                  <p>{t.description}</p>
                  <footer>
                    <span>
                      {resident
                        ? t.category
                        : data.residents.find((r) => r.id === t.residentId)
                            ?.name}
                    </span>
                    <small>{t.assignee}</small>
                  </footer>
                </button>
              ))}
            {!rows.some((t) => t.status === status) && (
              <p className="kanban-empty">No requests here.</p>
            )}
          </section>
        ))}
      </div>
      {edit && (
        <FormModal
          title={edit === true ? "New support request" : "Request details"}
          fields={[
            ...(!resident
              ? [
                  {
                    name: "residentId",
                    label: "Resident",
                    required: true,
                    options: data.residents.map((r) => ({
                      value: r.id,
                      label: r.name,
                    })),
                  },
                ]
              : []),
            { name: "subject", label: "Subject", required: true },
            {
              name: "category",
              label: "Category",
              required: true,
              options: options([
                "Electrical",
                "Plumbing",
                "Housekeeping",
                "Food",
                "Internet",
                "Other",
              ]),
            },
            {
              name: "priority",
              label: "Priority",
              required: true,
              options: options(["Normal", "High"]),
              value: "Normal",
            },
            {
              name: "description",
              label: "Describe the issue",
              type: "textarea",
              required: true,
            },
            ...(!resident
              ? [
                  {
                    name: "status",
                    label: "Status",
                    required: true,
                    options: options(["Open", "In progress", "Resolved"]),
                    value: "Open",
                  },
                  {
                    name: "assignee",
                    label: "Assign to",
                    options: options([
                      "Unassigned",
                      "Property team",
                      "Maintenance team",
                      "Owner",
                    ]),
                    value: "Unassigned",
                  },
                ]
              : []),
          ]}
          defaults={edit === true ? {} : { ...edit }}
          onClose={() => setEdit(null)}
          onSubmit={async (v) => {
            await save("tickets", {
              ...(edit === true
                ? {
                    status: "Open",
                    created: new Date().toISOString(),
                    assignee: "Unassigned",
                  }
                : { id: edit.id }),
              ...v,
              ...(resident ? { residentId: session?.residentId } : {}),
            });
          }}
        />
      )}
    </>
  );
}
export function Leads() {
  const { data, save } = useApp();
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  return (
    <>
      <PageHead
        title="Turn enquiries into new beginnings."
        description="Keep track of visits, company enquiries and property partnerships."
        action={
          <button className="btn" onClick={() => setEdit({})}>
            <Plus size={17} />
            Add enquiry
          </button>
        }
      />
      <Panel>
        <Table
          rows={data.leads}
          exportName="leads.csv"
          columns={[
            {
              label: "Name",
              key: "name",
              render: (l) => <Person name={l.name} detail={l.phone} />,
            },
            { label: "Type", key: "kind" },
            {
              label: "Visit date",
              key: "date",
              render: (l) => formatDate(l.date),
            },
            {
              label: "Status",
              key: "status",
              render: (l) => <Badge>{l.status}</Badge>,
            },
            { label: "Notes", key: "notes" },
            {
              label: "Action",
              key: "",
              render: (l) => (
                <button className="text-link" onClick={() => setEdit({ ...l })}>
                  View / edit
                </button>
              ),
            },
          ]}
        />
      </Panel>
      {edit && (
        <FormModal
          title="Enquiry details"
          fields={[
            { name: "name", label: "Name", required: true },
            { name: "phone", label: "Phone", type: "tel", required: true },
            { name: "email", label: "Email", type: "email" },
            {
              name: "date",
              label: "Visit / follow-up date",
              type: "date",
              required: true,
              value: today(),
            },
            {
              name: "kind",
              label: "Enquiry type",
              required: true,
              options: options(["Visit", "Corporate", "Property partner"]),
              value: "Visit",
            },
            {
              name: "propertyId",
              label: "Property",
              options: data.properties.map((p) => ({
                value: p.id,
                label: p.name,
              })),
            },
            {
              name: "status",
              label: "Status",
              required: true,
              options: options([
                "New",
                "Contacted",
                "Visit scheduled",
                "Converted",
                "Closed",
              ]),
              value: "New",
            },
            { name: "notes", label: "Notes", type: "textarea" },
          ]}
          defaults={edit}
          onClose={() => setEdit(null)}
          onSubmit={async (v) => {
            await save("leads", { ...v, ...(edit.id ? { id: edit.id } : {}) });
          }}
        />
      )}
    </>
  );
}
