import { AccountSecurity, DocumentUpload } from "./account";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Plus,
  Wallet,
  Wrench,
  FileSignature,
  Utensils,
  Check,
  Copy,
  Building2,
  Users,
} from "lucide-react";
import { useApp } from "./state";
import { DEMO } from "./api";
import {
  PageHead,
  Stats,
  Panel,
  Table,
  Badge,
  FormModal,
  Empty,
  SubmitForm,
  Alert,
  type Field,
} from "./components";
import { money, invoiceBalance, formatDate, today } from "./domain";
import {
  OwnerOverview,
  Residents,
  Inventory,
  Rent,
  Complaints,
  Leads,
  RentTable,
} from "./owner";
import {
  Inbox,
  Campaigns,
  Automation,
  Agreements,
  FinancialReports,
  Insights,
  Properties,
  Settings,
} from "./operations";
export function OwnerPortal() {
  const { section } = useParams();
  const screens: Record<string, React.ReactNode> = {
    overview: <OwnerOverview />,
    residents: <Residents />,
    inventory: <Inventory />,
    rent: <Rent />,
    complaints: <Complaints />,
    leads: <Leads />,
    inbox: <Inbox />,
    campaigns: <Campaigns />,
    automation: <Automation />,
    agreements: <Agreements />,
    finance: <FinancialReports />,
    insights: <Insights />,
    properties: <Properties />,
    settings: <Settings />,
  };
  return (
    screens[section || "overview"] || (
      <Empty
        title="Page not found"
        action={
          <Link to="/owner/overview" className="btn">
            Back to overview
          </Link>
        }
      />
    )
  );
}
export function ResidentPortal() {
  const { section } = useParams();
  const { data, session, action, notify } = useApp();
  const resident = data.residents.find((r) => r.id === session?.residentId);
  const invoices = data.invoices.filter(
    (i) => i.residentId === session?.residentId && !i.corporateId,
  );
  const property = data.properties.find((p) => p.id === resident?.propertyId);
  const [day, setDay] = useState(new Date().getDay());
  const meals = [
    ["Poha & chai", "Rajma, rice & roti", "Paneer curry & salad"],
    ["Idli & sambar", "Dal, vegetables & roti", "Chole & rice"],
    ["Paratha & curd", "Kadhi rice & salad", "Seasonal vegetables & roti"],
    ["Upma & chai", "Rajma rice & roti", "Dal makhani & rice"],
    ["Sandwich & fruit", "Chole rice & salad", "Mixed vegetables & roti"],
    ["Poha & milk", "Dal, rice & roti", "Paneer & pulao"],
    ["Paratha & chai", "Seasonal vegetables & roti", "Weekend thali"],
  ];
  const publishedMenu = (data.settings.mealMenu || {}) as Record<
    string,
    Record<string, string>
  >;
  const currentMenu = publishedMenu[String(day)];
  if (section === "security") return <AccountSecurity />;
  if (section === "complaints") return <Complaints resident />;
  if (section === "agreements")
    return (
      <>
        <Agreements scope="resident" />
        <DocumentUpload />
      </>
    );
  if (section === "rent")
    return (
      <>
        <PageHead
          title="Your rent, all in one place."
          description="Review your invoices, balances and payment history."
        />
        <Stats
          items={[
            {
              label: "Total billed",
              value: money(invoices.reduce((s, i) => s + i.amount, 0)),
            },
            {
              label: "Paid",
              value: money(invoices.reduce((s, i) => s + i.paid, 0)),
            },
            {
              label: "Outstanding",
              value: money(invoices.reduce((s, i) => s + invoiceBalance(i), 0)),
            },
          ]}
        />
        <Panel>
          <RentTable invoices={invoices} />
        </Panel>
        {resident?.corporateId && (
          <p className="form-note">
            Company-billed invoices are managed by your corporate contact.
          </p>
        )}
      </>
    );
  if (section === "food")
    return (
      <>
        <PageHead
          title="What’s cooking?"
          description="A little taste of home, every day."
        />
        <div className="tabs">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
            <button
              key={d}
              className={day === i ? "active" : ""}
              onClick={() => setDay(i)}
            >
              {d}
            </button>
          ))}
        </div>
        {DEMO || currentMenu ? (
          <div className="meal-grid">
            {["Breakfast", "Lunch", "Dinner"].map((label, i) => (
              <Panel key={label}>
                <span className="meal-icon">
                  <Utensils size={26} />
                </span>
                <span className="eyebrow">
                  {["7:30 – 9:30 AM", "12:30 – 2:30 PM", "7:30 – 9:30 PM"][i]}
                </span>
                <h2>{label}</h2>
                <p>
                  {currentMenu?.[["breakfast", "lunch", "dinner"][i]] ||
                    (DEMO ? meals[day][i] : "Not published")}
                </p>
                <Badge>{currentMenu ? "Published menu" : "Sample menu"}</Badge>
              </Panel>
            ))}
          </div>
        ) : (
          <Empty
            title="Menu not published yet"
            text="Your property team will publish the weekly menu here."
          />
        )}
        <Panel title="A note from the kitchen">
          <p>
            Menus may change based on seasonal availability. Tell your property
            team about any food allergies before joining the meal plan.
          </p>
        </Panel>
      </>
    );
  if (section === "refer")
    return (
      <>
        <PageHead
          title="Good homes are better with friends."
          description="Invite someone who is looking for their next place."
        />
        <div className="dashboard-grid">
          <Panel title="Share a home you love">
            <p>
              Send your friend a link to explore Sehrawat PG. Any referral
              benefit is subject to the property’s approved referral policy.
            </p>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    window.location.origin + "/explore",
                  );
                  notify("Explore link copied.");
                } catch {
                  notify("Copy the explore page URL from your browser.");
                }
              }}
            >
              <Copy size={16} />
              Copy explore link
            </button>
          </Panel>
          <Panel title="Refer a friend">
            <SubmitForm
              fields={[
                { name: "name", label: "Friend’s name", required: true },
                {
                  name: "phone",
                  label: "Friend’s phone",
                  type: "tel",
                  required: true,
                },
                {
                  name: "note",
                  label: "A note for the team",
                  type: "textarea",
                },
              ]}
              submit="Submit referral"
              onSubmit={async (v) => {
                await action("referrals", {
                  ...v,
                  residentId: session?.residentId,
                });
              }}
            />
            <p className="form-note">
              Share contact details only with your friend’s permission.
            </p>
          </Panel>
        </div>
      </>
    );
  if (section === "move-out")
    return (
      <>
        <PageHead
          title="Planning your next chapter?"
          description="Submit a move-out request and track your final settlement."
        />
        <div className="dashboard-grid">
          <Panel title="Request move-out">
            <SubmitForm
              fields={[
                {
                  name: "date",
                  label: "Requested move-out date",
                  type: "date",
                  min: today(),
                  required: true,
                },
                {
                  name: "reason",
                  label: "Reason / message",
                  type: "textarea",
                  required: true,
                },
              ]}
              submit="Submit move-out request"
              onSubmit={async (v) => {
                await action("move-outs", {
                  ...v,
                  residentId: session?.residentId,
                });
              }}
            />
          </Panel>
          <Panel title="What happens next">
            <ol className="timeline">
              <li>
                <b>Your request is reviewed</b>
                <p>The team checks your agreement and notice period.</p>
              </li>
              <li>
                <b>Final charges are prepared</b>
                <p>
                  Rent, utilities and any approved deductions are calculated.
                </p>
              </li>
              <li>
                <b>Check out and settlement</b>
                <p>The team confirms handover and eligible deposit refund.</p>
              </li>
            </ol>
          </Panel>
        </div>
        <Panel title="Your requests">
          <Table
            rows={data.requests.filter(
              (r) =>
                r.type === "move-outs" && r.residentId === session?.residentId,
            )}
            columns={[
              { label: "Requested date", key: "date" },
              { label: "Reason", key: "reason" },
              {
                label: "Status",
                key: "status",
                render: (r) => <Badge>{String(r.status)}</Badge>,
              },
            ]}
          />
        </Panel>
      </>
    );
  if (section !== "home")
    return (
      <Empty
        title="Page not found"
        action={
          <Link className="btn" to="/resident/home">
            My home
          </Link>
        }
      />
    );
  const balance = invoices.reduce((s, i) => s + invoiceBalance(i), 0);
  return (
    <>
      <PageHead
        eyebrow="YOUR SEHRAWAT SPACE"
        title={`Welcome home, ${session?.name.split(" ")[0]}.`}
        description={
          property
            ? `${property.name} · Room ${resident?.room}`
            : "Your stay details will appear after allocation."
        }
      />
      <div className="resident-welcome">
        <div>
          <span className="eyebrow">YOUR RENT SNAPSHOT</span>
          <h2>{money(balance)}</h2>
          <p>{balance ? "Outstanding balance" : "You’re all caught up."}</p>
          <Link className="btn light" to="/resident/rent">
            View rent & bills <ArrowRight size={16} />
          </Link>
        </div>
        <img
          src={property?.img || "/images/hero-lounge.jpg"}
          alt="Your residence"
        />
      </div>
      <div className="quick-links">
        {[
          ["rent", "Rent & bills", Wallet],
          ["complaints", "Ask for help", Wrench],
          ["food", "Today’s menu", Utensils],
          ["agreements", "My documents", FileSignature],
        ].map(([path, label, Icon]) => {
          const I = Icon as typeof Wallet;
          return (
            <Link to={"/resident/" + path} key={String(path)}>
              <I size={23} />
              <b>{String(label)}</b>
              <ArrowUpRight size={16} />
            </Link>
          );
        })}
      </div>
      <div className="dashboard-grid">
        <Panel title="Your stay">
          <div className="finance-summary">
            <div>
              <span>Property</span>
              <b>{property?.name || "Not assigned"}</b>
            </div>
            <div>
              <span>Room / bed</span>
              <b>{resident?.room || "Pending"}</b>
            </div>
            <div>
              <span>Monthly rent</span>
              <b>{money(resident?.rent || 0)}</b>
            </div>
            <div>
              <span>Stay status</span>
              <Badge>{resident?.status || "Pending"}</Badge>
            </div>
          </div>
        </Panel>
        <Panel
          title="Recent requests"
          action={
            <Link to="/resident/complaints" className="text-link">
              View all <ArrowRight size={14} />
            </Link>
          }
        >
          {data.tickets
            .filter((t) => t.residentId === session?.residentId)
            .map((t) => (
              <div className="recent-ticket" key={t.id}>
                <Wrench size={18} />
                <div>
                  <b>{t.subject}</b>
                  <p>{formatDate(t.created)}</p>
                </div>
                <Badge>{t.status}</Badge>
              </div>
            ))}
        </Panel>
      </div>
    </>
  );
}
export function CorporatePortal() {
  const { section } = useParams();
  const { data, session, save, action } = useApp();
  const [modal, setModal] = useState(false);
  const allocations = data.allocations.filter(
    (a) => a.corporateId === session?.corporateId,
  );
  const invoices = data.invoices.filter(
    (i) => i.corporateId === session?.corporateId,
  );
  const requests = data.requests.filter(
    (r) => r.corporateId === session?.corporateId,
  );
  const requestFields: Field[] = [
    {
      name: "propertyId",
      label: "Preferred property",
      required: true,
      options: data.properties.map((p) => ({ value: p.id, label: p.name })),
    },
    {
      name: "beds",
      label: "Beds required",
      type: "number",
      min: 1,
      max: 500,
      required: true,
    },
    {
      name: "start",
      label: "Expected move-in",
      type: "date",
      min: today(),
      required: true,
    },
    {
      name: "notes",
      label: "Requirements / employee details",
      type: "textarea",
      required: true,
    },
  ];
  if (section === "security") return <AccountSecurity />;
  if (section === "agreements") return <Agreements scope="corporate" />;
  if (section === "invoices")
    return (
      <>
        <PageHead
          title="Company billing, made clear."
          description="Review employee housing charges and your company’s outstanding balance."
        />
        <Stats
          items={[
            {
              label: "Company billed",
              value: money(invoices.reduce((s, i) => s + i.amount, 0)),
            },
            {
              label: "Amount paid",
              value: money(invoices.reduce((s, i) => s + i.paid, 0)),
            },
            {
              label: "Outstanding",
              value: money(invoices.reduce((s, i) => s + invoiceBalance(i), 0)),
            },
          ]}
        />
        <Panel>
          <RentTable invoices={invoices} />
        </Panel>
      </>
    );
  if (section === "requests")
    return (
      <>
        <PageHead
          title="Make room for your team."
          description="Request accommodation without making unverified bed reservations."
        />
        <div className="dashboard-grid">
          <Panel title="New housing request">
            <SubmitForm
              fields={requestFields}
              onSubmit={async (v) => {
                await action("housing-requests", {
                  ...v,
                  beds: Number(v.beds),
                  corporateId: session?.corporateId,
                });
              }}
              submit="Request accommodation"
            />
          </Panel>
          <Panel title="Your requests">
            <Table
              rows={requests}
              columns={[
                { label: "Move in", key: "start" },
                { label: "Beds", key: "beds" },
                {
                  label: "Status",
                  key: "status",
                  render: (r) => <Badge>{String(r.status)}</Badge>,
                },
              ]}
            />
          </Panel>
        </div>
      </>
    );
  if (section === "employees")
    return (
      <>
        <PageHead
          title="Help your people settle in."
          description="View employee stays and request new allocations."
          action={
            <button className="btn" onClick={() => setModal(true)}>
              <Plus size={16} />
              Request employee stay
            </button>
          }
        />
        <Panel>
          <Table
            rows={allocations}
            exportName="employee-allocations.csv"
            columns={[
              { label: "Employee", key: "employee" },
              {
                label: "Property",
                key: "propertyId",
                render: (a) =>
                  data.properties.find((p) => p.id === a.propertyId)?.name,
              },
              { label: "Room", key: "room" },
              {
                label: "Move in",
                key: "start",
                render: (a) => formatDate(a.start),
              },
              {
                label: "End date",
                key: "end",
                render: (a) => formatDate(a.end),
              },
              {
                label: "Status",
                key: "status",
                render: (a) => <Badge>{a.status}</Badge>,
              },
            ]}
          />
        </Panel>
        {modal && (
          <FormModal
            title="Request an employee stay"
            fields={[
              { name: "employee", label: "Employee name", required: true },
              {
                name: "email",
                label: "Employee email",
                type: "email",
                required: true,
              },
              ...requestFields.filter((f) => f.name !== "beds"),
            ]}
            onClose={() => setModal(false)}
            submit="Submit allocation request"
            onSubmit={async (v) => {
              await action("housing-requests", {
                ...v,
                beds: 1,
                corporateId: session?.corporateId,
              });
            }}
          />
        )}
      </>
    );
  if (section !== "overview")
    return (
      <Empty
        title="Page not found"
        action={
          <Link to="/corporate/overview" className="btn">
            Company overview
          </Link>
        }
      />
    );
  return (
    <>
      <PageHead
        eyebrow="CORPORATE HOUSING"
        title={`Welcome, ${session?.name}.`}
        description="Give your team a comfortable start in their new city."
        action={
          <Link className="btn" to="/corporate/requests">
            <Plus size={16} />
            Request beds
          </Link>
        }
      />
      <Stats
        items={[
          { label: "Employee stays", value: allocations.length, icon: Users },
          {
            label: "Active allocations",
            value: allocations.filter((a) => a.status === "Active").length,
            icon: Building2,
          },
          {
            label: "Outstanding invoices",
            value: money(invoices.reduce((s, i) => s + invoiceBalance(i), 0)),
            icon: Wallet,
          },
          {
            label: "Housing requests",
            value: requests.length,
            icon: Building2,
          },
        ]}
      />
      <Panel
        title="Your employee stays"
        action={
          <Link className="text-link" to="/corporate/employees">
            View employees <ArrowUpRight size={15} />
          </Link>
        }
      >
        <Table
          rows={allocations}
          columns={[
            { label: "Employee", key: "employee" },
            {
              label: "Residence",
              key: "propertyId",
              render: (a) =>
                data.properties.find((p) => p.id === a.propertyId)?.name,
            },
            { label: "Room", key: "room" },
            {
              label: "Status",
              key: "status",
              render: (a) => <Badge>{a.status}</Badge>,
            },
          ]}
        />
      </Panel>
    </>
  );
}
