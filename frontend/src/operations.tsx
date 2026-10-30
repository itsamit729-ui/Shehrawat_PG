import { MealSettings } from "./services";
import { useState } from "react";
import {
  Plus,
  Send,
  FileSignature,
  ArrowUpRight,
  Check,
  MessageSquare,
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
  formatDate,
  today,
  canReply,
  safeExternalUrl,
  type Property,
} from "./domain";
import { Occupancy } from "./owner";
const options = (v: string[]) => v.map((value) => ({ value, label: value }));
export function Inbox() {
  usePolling("conversations", 5000);
  const { data, action, save } = useApp();
  const [selected, setSelected] = useState(data.conversations[0]?.id || "");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const c = data.conversations.find((c) => c.id === selected);
  const allowed = c && canReply(c.lastInbound);
  async function mode(value: string) {
    try {
      if (c)
        await save("conversations", {
          id: c.id,
          mode: value,
          assignee: value === "Human" ? "Owner" : "Unassigned",
        });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <PageHead
        title="One inbox. Every conversation."
        description="Help residents, answer enquiries and hand conversations between the bot and your team."
      />
      {error && <Alert>{error}</Alert>}
      <div className="inbox">
        <aside>
          <label className="search-input">
            <input
              placeholder="Search conversations"
              aria-label="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {data.conversations
            .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
            .map((c) => (
              <button
                className={
                  selected === c.id ? "conversation active" : "conversation"
                }
                key={c.id}
                onClick={() => {
                  setSelected(c.id);
                  setBody("");
                  setError("");
                }}
              >
                <span className="avatar">
                  {c.name.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <b>{c.name}</b>
                  <small>{c.messages.at(-1)?.body}</small>
                  <em>
                    {c.mode} · {c.assignee}
                  </em>
                </span>
              </button>
            ))}
        </aside>
        {c ? (
          <section className="chat">
            <header>
              <div>
                <b>{c.name}</b>
                <small>
                  {allowed
                    ? "Customer service window open"
                    : "Template required to restart conversation"}
                </small>
              </div>
              <label className="chat-mode">
                <span>Assigned to</span>
                <select
                  aria-label="Conversation mode"
                  value={c.mode}
                  onChange={(e) => void mode(e.target.value)}
                >
                  <option value="Human">Owner · human</option>
                  <option value="Bot">Automated bot</option>
                </select>
              </label>
            </header>
            <div
              className="messages"
              role="log"
              aria-label="Conversation messages"
            >
              {c.messages.map((m) => (
                <div
                  key={m.id}
                  className={
                    "bubble " +
                    (m.sender === "customer" ? "incoming" : "outgoing")
                  }
                >
                  <p>{m.body}</p>
                  <small>
                    {new Date(m.time).toLocaleTimeString("en-IN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {m.status}
                  </small>
                </div>
              ))}
            </div>
            <form
              className="composer"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!body.trim() || !allowed || c.mode !== "Human") return;
                setBusy(true);
                setError("");
                try {
                  await action("messages/send", {
                    conversationId: c.id,
                    body: body.trim(),
                  });
                  setBody("");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label className="sr-only" htmlFor="reply">
                Write your reply
              </label>
              <textarea
                id="reply"
                maxLength={4000}
                value={body}
                disabled={!allowed || c.mode !== "Human"}
                placeholder={
                  c.mode === "Bot"
                    ? "Assign to Owner to reply"
                    : allowed
                      ? "Write a helpful reply…"
                      : "Use an approved template outside the service window."
                }
                onChange={(e) => setBody(e.target.value)}
              />
              <button
                className="btn"
                disabled={
                  busy || !body.trim() || !allowed || c.mode !== "Human"
                }
                aria-label="Send reply"
              >
                <Send size={18} />
              </button>
            </form>
          </section>
        ) : (
          <Empty
            title="Choose a conversation"
            text="Incoming WhatsApp conversations will appear here."
          />
        )}
      </div>
    </>
  );
}
export function Campaigns() {
  const { data, save, action } = useApp();
  const [open, setOpen] = useState(false);
  const [schedule, setSchedule] = useState<string | null>(null);
  return (
    <>
      <PageHead
        title="Reach the right people."
        description="Create template-based campaigns for contacts who have opted in."
        action={
          <button className="btn" onClick={() => setOpen(true)}>
            <Plus size={17} />
            New campaign
          </button>
        }
      />
      <Stats
        items={[
          {
            label: "Monthly marketing allowance",
            value: "1,000",
            detail: "Planned delivered-message cap",
          },
          {
            label: "Delivered",
            value: data.campaigns.reduce((s, c) => s + c.delivered, 0),
          },
          {
            label: "Campaign drafts",
            value: data.campaigns.filter((c) => c.status === "Draft").length,
          },
          {
            label: "Scheduled",
            value: data.campaigns.filter((c) => c.status === "Scheduled")
              .length,
          },
        ]}
      />
      <Panel>
        <Table
          rows={data.campaigns}
          columns={[
            { label: "Campaign", key: "name" },
            { label: "Template", key: "template" },
            { label: "Audience", key: "audience" },
            { label: "Recipients", key: "recipients" },
            {
              label: "Status",
              key: "status",
              render: (c) => <Badge>{c.status}</Badge>,
            },
            {
              label: "Action",
              key: "",
              render: (c) =>
                c.status === "Draft" ? (
                  <button
                    className="text-link"
                    onClick={() => setSchedule(c.id)}
                  >
                    Review & schedule
                  </button>
                ) : (
                  <span>
                    {c.scheduled ? formatDate(c.scheduled) : "Scheduled"}
                  </span>
                ),
            },
          ]}
        />
      </Panel>
      {open && (
        <FormModal
          title="New campaign draft"
          description="The backend must validate template approval and current contact consent before delivery."
          fields={[
            { name: "name", label: "Campaign name", required: true },
            {
              name: "template",
              label: "Template name",
              required: true,
              placeholder: "Approved Meta template identifier",
            },
            {
              name: "audience",
              label: "Audience",
              required: true,
              options: options(["Opted-in leads", "Opted-in residents"]),
            },
            {
              name: "scheduled",
              label: "Scheduled time",
              type: "datetime-local",
              required: true,
            },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => {
            if (new Date(v.scheduled).getTime() <= Date.now())
              throw new Error("Choose a future schedule time.");
            await save("campaigns", {
              ...v,
              status: "Draft",
              recipients: 0,
              delivered: 0,
            });
          }}
        />
      )}
      {schedule && (
        <FormModal
          title="Review campaign delivery"
          description="Only approved templates and opted-in contacts may be sent. Actual recipients and remaining quota are checked by the backend."
          fields={[
            {
              name: "confirmation",
              label: "Type SCHEDULE to confirm",
              required: true,
            },
          ]}
          submit="Schedule campaign"
          onClose={() => setSchedule(null)}
          onSubmit={async (v) => {
            if (v.confirmation !== "SCHEDULE")
              throw new Error("Type SCHEDULE to confirm.");
            await action("campaigns/schedule", { id: schedule });
          }}
        />
      )}
    </>
  );
}
export function Automation() {
  const { data, action } = useApp();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const rules = [
    [
      "rentReminder",
      "Rent due reminder",
      "Utility template sent before the rent due date.",
    ],
    [
      "paymentReceipt",
      "Payment confirmation",
      "A receipt link after a verified captured payment.",
    ],
    [
      "moveInWelcome",
      "Move-in welcome",
      "Useful information after booking confirmation.",
    ],
    [
      "complaintUpdate",
      "Complaint update",
      "Keep residents informed when their request changes.",
    ],
    [
      "agreementReminder",
      "Agreement reminder",
      "Follow up on an unsigned agreement.",
    ],
  ];
  return (
    <>
      <PageHead
        title="Thoughtful follow-ups, on time."
        description="Configure the message workflows that support everyday operations."
      />
      {error && <Alert>{error}</Alert>}
      <Panel
        title="Message rules"
        description="Delivery uses the backend scheduler, approved templates and recipient consent."
      >
        {rules.map(([key, title, text]) => (
          <div className="rule" key={key}>
            <span className="rule-icon">
              <MessageSquare size={21} />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
              <Badge>Utility template</Badge>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                aria-label={title}
                checked={Boolean(data.settings[key])}
                disabled={busy === key}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setBusy(key);
                  try {
                    await action("settings", { [key]: enabled });
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy("");
                  }
                }}
              />
              <span />
            </label>
          </div>
        ))}
      </Panel>
    </>
  );
}
export function Agreements({
  scope = "owner",
}: {
  scope?: "owner" | "resident" | "corporate";
}) {
  const { data, session, save, action, notify } = useApp();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const ids =
    scope === "resident"
      ? [session?.residentId]
      : scope === "corporate"
        ? data.residents
            .filter((r) => r.corporateId === session?.corporateId)
            .map((r) => r.id)
        : null;
  const rows = data.agreements.filter(
    (a) => !ids || ids.includes(a.residentId),
  );
  async function handle(id: string) {
    setError("");
    setBusy(id);
    try {
      if (DEMO) {
        notify("Signing preview only. No agreement was sent or signed.");
        return;
      }
      const result = (await action("agreements/" + id + "/link", {})) as {
        url: string;
      };
      const u = safeExternalUrl(result.url);
      if (!u) throw new Error("The document link could not be verified.");
      window.location.assign(u);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <PageHead
        title="Agreements, without the paperwork."
        description="Review document status and access secure signing or download links."
        action={
          scope === "owner" ? (
            <button className="btn" onClick={() => setOpen(true)}>
              <Plus size={17} />
              Prepare agreement
            </button>
          ) : undefined
        }
      />
      {error && <Alert>{error}</Alert>}
      <Panel>
        <Table
          rows={rows}
          columns={[
            {
              label: "Document",
              key: "title",
              render: (a) => (
                <div className="document-name">
                  <FileSignature size={21} />
                  <div>
                    <b>{a.title}</b>
                    <small>{a.id}</small>
                  </div>
                </div>
              ),
            },
            {
              label: "Resident",
              key: "residentId",
              render: (a) =>
                data.residents.find((r) => r.id === a.residentId)?.name ||
                a.residentId,
            },
            {
              label: "Created",
              key: "created",
              render: (a) => formatDate(a.created),
            },
            {
              label: "Status",
              key: "status",
              render: (a) => <Badge>{a.status}</Badge>,
            },
            {
              label: "Action",
              key: "",
              render: (a) => (
                <button
                  className="text-link"
                  disabled={busy === a.id}
                  onClick={() => void handle(a.id)}
                >
                  {busy === a.id
                    ? "Opening…"
                    : a.status === "Signed"
                      ? "View signed copy"
                      : scope === "owner"
                        ? "Open signing request"
                        : "Review & sign"}
                  <ArrowUpRight size={14} />
                </button>
              ),
            },
          ]}
        />
      </Panel>
      {open && (
        <FormModal
          title="Prepare agreement"
          description="The backend generates an approved template and creates the provider request."
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
              name: "title",
              label: "Agreement title",
              required: true,
              value: "Residential stay agreement",
            },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => {
            await save("agreements", {
              ...v,
              status: "Draft",
              created: new Date().toISOString(),
            });
          }}
        />
      )}
    </>
  );
}
export function FinancialReports() {
  const { data, save } = useApp();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(today().slice(0, 7));
  const invoices = data.invoices.filter((i) => i.period === period);
  const expenses = data.expenses.filter((e) => e.date.startsWith(period));
  const billed = invoices.reduce((s, i) => s + i.amount, 0),
    collected = invoices.reduce((s, i) => s + i.paid, 0),
    spent = expenses.reduce((s, e) => s + e.amount, 0);
  return (
    <>
      <PageHead
        title="Know where your business stands."
        description="An operational view of income, expenses and outstanding rent."
        action={
          <label className="field">
            <span>Reporting month</span>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </label>
        }
      />
      <Stats
        items={[
          {
            label: "Rent billed",
            value: money(billed),
            detail: "Invoice basis",
          },
          {
            label: "Rent collected",
            value: money(collected),
            detail: "Recorded payment basis",
          },
          {
            label: "Recorded expenses",
            value: money(spent),
            detail: "Approved manual expense entries",
          },
          {
            label: "Operating balance",
            value: money(collected - spent),
            detail: "Collections less recorded expenses",
          },
        ]}
      />
      <div className="dashboard-grid">
        <Panel
          title="Collection summary"
          description="Gross amounts before gateway settlement adjustments"
        >
          <div className="finance-summary">
            <div>
              <span>Billed rent</span>
              <b>{money(billed)}</b>
            </div>
            <div>
              <span>Recorded collections</span>
              <b>{money(collected)}</b>
            </div>
            <div>
              <span>Outstanding balance</span>
              <b>{money(billed - collected)}</b>
            </div>
            <div>
              <span>Recorded expenses</span>
              <b>{money(spent)}</b>
            </div>
          </div>
          <p className="form-note">
            Deposits, refunds, gateway fees and settlement reconciliation need
            backend ledger data. This is not a statutory accounting statement.
          </p>
        </Panel>
        <Panel title="Property occupancy">
          <Occupancy />
        </Panel>
      </div>
      <Panel
        title="Expense register"
        action={
          <button
            className="btn secondary compact"
            onClick={() => setOpen(true)}
          >
            <Plus size={16} />
            Add expense
          </button>
        }
      >
        <Table
          rows={expenses}
          exportName={`expenses-${period}.csv`}
          columns={[
            { label: "Date", key: "date", render: (e) => formatDate(e.date) },
            { label: "Category", key: "category" },
            { label: "Description", key: "description" },
            { label: "Amount", key: "amount", render: (e) => money(e.amount) },
          ]}
        />
      </Panel>
      {open && (
        <FormModal
          title="Record an expense"
          fields={[
            {
              name: "category",
              label: "Category",
              required: true,
              options: options([
                "Food",
                "Utilities",
                "Staff",
                "Maintenance",
                "Other",
              ]),
            },
            { name: "description", label: "Description", required: true },
            {
              name: "amount",
              label: "Amount (₹)",
              type: "number",
              min: 1,
              required: true,
            },
            {
              name: "date",
              label: "Expense date",
              type: "date",
              required: true,
              value: today(),
            },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => {
            await save("expenses", { ...v, amount: Number(v.amount) });
          }}
        />
      )}
    </>
  );
}
export function Insights() {
  const { data } = useApp();
  const active = data.residents.filter((r) => r.status === "Active").length;
  return (
    <>
      <PageHead
        title="Get to know your community."
        description="Understand resident distribution and occupancy at a glance."
      />
      <Stats
        items={[
          { label: "Resident profiles", value: data.residents.length },
          { label: "Active stays", value: active },
          {
            label: "Corporate residents",
            value: data.residents.filter((r) => r.corporateId).length,
          },
          {
            label: "On notice",
            value: data.residents.filter((r) => r.status === "Notice").length,
          },
        ]}
      />
      <div className="dashboard-grid">
        <Panel title="Residents by property">
          <div className="occupancy-list">
            {data.properties.map((p) => {
              const count = data.residents.filter(
                (r) => r.propertyId === p.id,
              ).length;
              return (
                <div key={p.id}>
                  <div>
                    <span>{p.name}</span>
                    <b>{count}</b>
                  </div>
                  <div className="progress orange">
                    <span
                      style={{
                        width:
                          Math.max(
                            0,
                            (count / Math.max(1, data.residents.length)) * 100,
                          ) + "%",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel title="Occupancy across homes">
          <Occupancy />
        </Panel>
      </div>
    </>
  );
}
export function Properties() {
  const { data, save } = useApp();
  const [edit, setEdit] = useState<Property | null>(null);
  return (
    <>
      <PageHead
        title="Homes with their own character."
        description="Keep public listing details current and accurate."
      />
      <div className="property-grid portal-properties">
        {data.properties.map((p) => (
          <Panel key={p.id} className="property-admin">
            <img src={p.img} alt={p.name} />
            <div>
              <Badge>{p.gender}</Badge>
              <h2>{p.name}</h2>
              <p>{p.area}</p>
              <div className="mini-stats">
                <span>
                  <b>{p.beds}</b>Total beds
                </span>
                <span>
                  <b>
                    {
                      data.beds.filter(
                        (b) => b.propertyId === p.id && b.status === "Occupied",
                      ).length
                    }
                  </b>
                  Occupied
                </span>
              </div>
              <button
                className="btn secondary full-width"
                onClick={() => setEdit(p)}
              >
                Edit listing <ArrowUpRight size={16} />
              </button>
            </div>
          </Panel>
        ))}
      </div>
      {edit && (
        <FormModal
          title="Edit property listing"
          fields={[
            { name: "name", label: "Property name", required: true },
            { name: "area", label: "Locality", required: true },
            { name: "sector", label: "Nearby landmark", required: true },
            {
              name: "gender",
              label: "Resident preference",
              required: true,
              options: options(["Men", "Women", "Unisex"]),
            },
            {
              name: "blurb",
              label: "Listing description",
              type: "textarea",
              required: true,
            },
          ]}
          defaults={{ ...edit }}
          onClose={() => setEdit(null)}
          onSubmit={async (v) => {
            await save("properties", { id: edit.id, ...v });
          }}
        />
      )}
    </>
  );
}
export function Settings() {
  const { data, action, reset } = useApp();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHead
        title="The details behind a good stay."
        description="Business preferences and operating limits."
      />
      <div className="dashboard-grid">
        <Panel title="Business settings">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const v = Object.fromEntries(new FormData(e.currentTarget));
              try {
                await action("settings", {
                  businessName: v.businessName,
                  rentDay: Number(v.rentDay),
                });
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
                  name: "businessName",
                  label: "Business name",
                  required: true,
                },
                {
                  name: "rentDay",
                  label: "Rent due day of month",
                  type: "number",
                  min: 1,
                  max: 28,
                  required: true,
                },
              ]}
              defaults={data.settings}
            />
            {error && <Alert>{error}</Alert>}
            <button className="btn" disabled={busy}>
              {busy ? "Saving…" : "Save preferences"}
              <Check size={16} />
            </button>
          </form>
        </Panel>
        <Panel title="Account & service profile">
          <div className="finance-summary">
            <div>
              <span>Owner authentication</span>
              <b>SMS OTP</b>
            </div>
            <div>
              <span>Property capacity</span>
              <b>500 beds</b>
            </div>
            <div>
              <span>Marketing messages</span>
              <b>1,000 / month</b>
            </div>
            <div>
              <span>Maintenance</span>
              <b>₹3,500 / month</b>
            </div>
          </div>
          <p className="form-note">
            Provider keys and security settings belong in the backend, never in
            this frontend.
          </p>
          {DEMO && (
            <button
              className="btn secondary"
              onClick={() => {
                if (
                  window.confirm(
                    "Reset all preview records to the original sample data?",
                  )
                )
                  reset();
              }}
            >
              Reset preview data
            </button>
          )}
        </Panel>
      </div>
      <MealSettings />
    </>
  );
}
