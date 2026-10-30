import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  MapPin,
  Search,
  ShieldCheck,
  Wifi,
  Utensils,
  Heart,
  Building2,
  Users,
  Clock,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  LockKeyhole,
} from "lucide-react";
import {
  PublicLayout,
  PageHead,
  Panel,
  Empty,
  Loading,
  Alert,
  SubmitForm,
  Fields,
  Badge,
  type Field,
} from "./components";
import { useApp, usePolling } from "./state";
import { DEMO, request } from "./api";
import {
  money,
  minPrice,
  filterProperties,
  today,
  safeExternalUrl,
  type Property,
  type Role,
} from "./domain";
export function PropertyCard({ property: p }: { property: Property }) {
  const [saved, setSaved] = useState(false);
  return (
    <article className="property-card">
      <div className="property-image">
        <Link to={"/properties/" + p.id}>
          <img
            src={p.img}
            alt={`${p.name} living space`}
            loading="lazy"
            width="600"
            height="430"
          />
        </Link>
        <span className="image-tag">
          {p.gender === "Unisex" ? "For everyone" : p.gender + " only"}
        </span>
        <button
          className={"save-button " + (saved ? "saved" : "")}
          aria-label={(saved ? "Remove " : "Save ") + p.name}
          aria-pressed={saved}
          onClick={() => setSaved(!saved)}
        >
          <Heart size={18} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="property-content">
        <p className="location">
          <MapPin size={14} />
          {p.area}
        </p>
        <h3>
          <Link to={"/properties/" + p.id}>{p.name}</Link>
        </h3>
        <p className="property-blurb">{p.blurb}</p>
        <div className="amenity-line">
          <span>
            <Wifi size={14} />
            WiFi
          </span>
          <span>
            <Utensils size={14} />
            Meals
          </span>
          <span>
            <ShieldCheck size={14} />
            Managed
          </span>
        </div>
        <div className="property-bottom">
          <div>
            <strong>{money(minPrice(p))}</strong>
            <span> / month onwards</span>
          </div>
          <Link
            className="circle-link"
            aria-label={"View " + p.name}
            to={"/properties/" + p.id}
          >
            <ArrowUpRight size={21} />
          </Link>
        </div>
      </div>
    </article>
  );
}
function DataStatus() {
  const { error, loading, refresh } = useApp();
  return loading ? (
    <Loading />
  ) : error ? (
    <Alert>
      {error}{" "}
      <button className="text-link" onClick={() => void refresh()}>
        Try again
      </button>
    </Alert>
  ) : null;
}
export function HomePage() {
  const { data } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <PublicLayout>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="live-dot" /> A BETTER WAY TO LIVE IN GURUGRAM
            </span>
            <h1>
              New city.
              <br />
              New beginnings.
              <br />
              <em>Your kind of home.</em>
            </h1>
            <p>
              Good food, thoughtful spaces and people who get you. Discover a
              home that makes everyday life a little easier.
            </p>
            <form
              className="hero-search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate("/explore?q=" + encodeURIComponent(q));
              }}
            >
              <MapPin size={20} />
              <label className="sr-only" htmlFor="hero-area">
                Search locality
              </label>
              <input
                id="hero-area"
                placeholder="Where would you like to live?"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <button className="btn">
                Find a home <ArrowRight size={17} />
              </button>
            </form>
            <div className="hero-points">
              <span>
                <Check size={15} />
                No brokerage
              </span>
              <span>
                <Check size={15} />
                Fully furnished
              </span>
              <span>
                <Check size={15} />
                Everyday care
              </span>
            </div>
          </div>
          <div className="hero-visual">
            <img
              className="hero-photo"
              src="/images/hero-lounge.jpg"
              width="700"
              height="820"
              fetchPriority="high"
              alt="A sunlit lounge with comfortable seating"
            />
            <div className="hero-caption">
              <span className="caption-icon">
                <HomeIcon />
              </span>
              <div>
                <b>More than a room.</b>
                <span>A place to belong.</span>
              </div>
            </div>
            <span className="hero-stamp">
              UNPACK.
              <br />
              UNWIND.
              <br />
              BELONG.
            </span>
          </div>
        </div>
      </section>
      <section className="benefit-strip">
        <div className="container">
          <span>
            <Utensils />
            Home-style meals
          </span>
          <span>
            <Wifi />
            Work-ready WiFi
          </span>
          <span>
            <ShieldCheck />
            Thoughtful care
          </span>
          <span>
            <Users />
            Your kind of people
          </span>
        </div>
      </section>
      <section className="section container">
        <div className="section-heading">
          <div>
            <span className="eyebrow">FIND YOUR CORNER</span>
            <h2>A home for every chapter.</h2>
            <p>Close to work. Close to everything that matters.</p>
          </div>
          <Link className="text-link" to="/explore">
            Explore all homes <ArrowRight size={17} />
          </Link>
        </div>
        <DataStatus />
        <div className="property-grid">
          {data.properties.slice(0, 3).map((p) => (
            <PropertyCard key={p.id} property={p} />
          ))}
        </div>
      </section>
      <section className="section soft">
        <div className="container split">
          <img
            className="rounded-photo"
            src="/images/dining.jpg"
            loading="lazy"
            width="650"
            height="550"
            alt="Shared dining space"
          />
          <div>
            <span className="eyebrow">THE LITTLE THINGS, TAKEN CARE OF</span>
            <h2>
              Less life admin.
              <br />
              More living.
            </h2>
            <p className="lead">
              From your first cup of chai to your last call of the day, your
              space should work around you.
            </p>
            <div className="feature-stack">
              {[
                [
                  "01",
                  "Move in, settle in",
                  "Furnished rooms with space to study, work and make your own.",
                ],
                [
                  "02",
                  "Meals that feel familiar",
                  "A weekly menu and shared tables that make dinner better.",
                ],
                [
                  "03",
                  "Help when you need it",
                  "Raise a request from your portal and follow it to resolution.",
                ],
              ].map(([n, t, s]) => (
                <div key={n}>
                  <span>{n}</span>
                  <div>
                    <h3>{t}</h3>
                    <p>{s}</p>
                  </div>
                </div>
              ))}
            </div>
            <Link to="/safety" className="text-link">
              Meet your everyday support system <ArrowRight size={17} />
            </Link>
          </div>
        </div>
      </section>
      <section className="section container">
        <div className="cta">
          <div>
            <span className="eyebrow">A NEW CHAPTER STARTS HERE</span>
            <h2>Come take a look around.</h2>
            <p>Find a place you like and schedule a visit.</p>
          </div>
          <Link to="/explore" className="btn light">
            Find your home <ArrowUpRight size={19} />
          </Link>
        </div>
      </section>
    </PublicLayout>
  );
}
function HomeIcon() {
  return <Building2 size={24} />;
}
export function ExplorePage() {
  const { data } = useApp();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "",
    gender = params.get("gender") || "",
    sharing = params.get("sharing") || "",
    budget = Number(params.get("budget")) || 30000;
  const [sort, setSort] = useState("recommended");
  const update = (key: string, value: string) => {
    const n = new URLSearchParams(params);
    value ? n.set(key, value) : n.delete(key);
    setParams(n, { replace: true });
  };
  const properties = filterProperties(
    data.properties,
    q,
    gender,
    budget,
    sharing,
  ).sort((a, b) =>
    sort === "price-low"
      ? minPrice(a) - minPrice(b)
      : sort === "price-high"
        ? minPrice(b) - minPrice(a)
        : 0,
  );
  return (
    <PublicLayout>
      <section className="section container">
        <PageHead
          eyebrow="A SPACE THAT FEELS LIKE YOU"
          title="Find your next home."
          description="Thoughtfully managed residences across Gurugram."
        />
        <div className="filter-bar">
          <label className="search-input">
            <Search size={18} />
            <input
              aria-label="Search locations"
              placeholder="Search locality or residence"
              value={q}
              onChange={(e) => update("q", e.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">Resident preference</span>
            <select
              value={gender}
              onChange={(e) => update("gender", e.target.value)}
            >
              <option value="">Everyone</option>
              <option>Men</option>
              <option>Women</option>
              <option value="Unisex">Unisex</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Room sharing</span>
            <select
              value={sharing}
              onChange={(e) => update("sharing", e.target.value)}
            >
              <option value="">Any sharing</option>
              <option value="single">Single</option>
              <option value="double">Double</option>
              <option value="triple">Triple</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Maximum budget</span>
            <select
              value={budget}
              onChange={(e) => update("budget", e.target.value)}
            >
              {[10000, 15000, 20000, 30000].map((n) => (
                <option value={n} key={n}>
                  Up to {money(n)}
                </option>
              ))}
            </select>
          </label>
          <button className="text-link" onClick={() => setParams({})}>
            Reset filters
          </button>
        </div>
        <div className="results-row">
          <b>{properties.length} homes to explore</b>
          <label>
            Sort by{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recommended">Recommended</option>
              <option value="price-low">Price: low to high</option>
              <option value="price-high">Price: high to low</option>
            </select>
          </label>
        </div>
        <DataStatus />
        {properties.length ? (
          <div className="property-grid">
            {properties.map((p) => (
              <PropertyCard key={p.id} property={p} />
            ))}
          </div>
        ) : (
          <Empty
            title="Your next home is worth finding"
            text="Try a different location or increase your budget."
            action={
              <button className="btn" onClick={() => setParams({})}>
                Clear filters
              </button>
            }
          />
        )}
      </section>
    </PublicLayout>
  );
}
const contactFields: Field[] = [
  { name: "name", label: "Full name", required: true },
  { name: "phone", label: "Phone number", type: "tel", required: true },
  { name: "email", label: "Email", type: "email", required: true },
];
export function PropertyPage() {
  usePolling("properties", 15000);
  const { id } = useParams();
  const { data, save } = useApp();
  const [image, setImage] = useState(0);
  const [visit, setVisit] = useState(false);
  const p = data.properties.find((p) => p.id === id);
  if (!p)
    return (
      <PublicLayout>
        <section className="container section">
          <DataStatus />
          <Empty
            title="Residence not found"
            action={
              <Link className="btn" to="/explore">
                Browse homes
              </Link>
            }
          />
        </section>
      </PublicLayout>
    );
  return (
    <PublicLayout>
      <section className="container section property-detail">
        <Link to="/explore" className="text-link">
          <ChevronLeft size={16} />
          All homes
        </Link>
        <PageHead
          eyebrow={p.area}
          title={p.name}
          description={p.sector}
          action={
            <Badge>
              {p.gender === "Unisex" ? "For everyone" : p.gender + " only"}
            </Badge>
          }
        />
        <div className="gallery">
          <img
            src={"/images/" + p.gallery[image] + ".jpg"}
            alt={`${p.name} photo ${image + 1}`}
            width="1100"
            height="600"
          />
          <button
            className="gallery-prev icon-button"
            aria-label="Previous photo"
            onClick={() =>
              setImage((image + p.gallery.length - 1) % p.gallery.length)
            }
          >
            <ChevronLeft />
          </button>
          <button
            className="gallery-next icon-button"
            aria-label="Next photo"
            onClick={() => setImage((image + 1) % p.gallery.length)}
          >
            <ChevronRight />
          </button>
          <div className="gallery-count">
            {image + 1} / {p.gallery.length}
          </div>
        </div>
        <div className="detail-grid">
          <div>
            <h2>A little more about your home.</h2>
            <p className="lead">{p.blurb}</p>
            <div className="amenity-grid">
              {p.amenities.map((a) => (
                <div key={a}>
                  <Check size={17} />
                  {a === "food"
                    ? "Meals included"
                    : a === "wifi"
                      ? "WiFi"
                      : a === "ac"
                        ? "Air conditioning"
                        : a}
                </div>
              ))}
            </div>
            <h2>Choose your space.</h2>
            <div className="room-options">
              {Object.entries(p.rooms).map(([type, r]) => (
                <div className="room-option" key={type}>
                  <div>
                    <h3>{type} sharing</h3>
                    <p>
                      {r.left > 0
                        ? `${r.left} beds shown as available`
                        : "Currently unavailable"}
                    </p>
                  </div>
                  <strong>
                    {money(r.price)}
                    <small> / month</small>
                  </strong>
                  <Link
                    to={`/book/${p.id}?sharing=${type}`}
                    aria-disabled={!r.left}
                    onClick={(e) => {
                      if (!r.left) e.preventDefault();
                    }}
                    className={"btn secondary " + (!r.left ? "disabled" : "")}
                  >
                    Select <ArrowRight size={15} />
                  </Link>
                </div>
              ))}
            </div>
            <h2>Your neighbourhood.</h2>
            <div className="landmarks">
              {p.landmarks.map(([place, time]) => (
                <div key={place}>
                  <MapPin size={17} />
                  <span>{place}</span>
                  <b>{time}</b>
                </div>
              ))}
            </div>
            <Panel title="Before you move in">
              <p>
                Final rent, deposit, meal plan, house rules and cancellation
                terms will be shown before you confirm a booking.
              </p>
              <Link className="text-link" to="/legal">
                Read the terms <ArrowUpRight size={15} />
              </Link>
            </Panel>
          </div>
          <aside className="booking-aside">
            <Panel title="Make room for a new start.">
              <span className="muted">Monthly rent from</span>
              <div className="big-price">{money(minPrice(p))}</div>
              <p>
                Furnished space. Everyday essentials. One place to call home.
              </p>
              <Link className="btn full-width" to={"/book/" + p.id}>
                Choose your room <ArrowRight size={17} />
              </Link>
              <button
                className="btn secondary full-width"
                onClick={() => setVisit(!visit)}
              >
                <CalendarDays size={16} />
                {visit ? "Close visit form" : "Schedule a visit"}
              </button>
              {visit && (
                <SubmitForm
                  fields={[
                    ...contactFields,
                    {
                      name: "date",
                      label: "Visit date",
                      type: "date",
                      min: today(),
                      required: true,
                    },
                  ]}
                  submit="Request a visit"
                  onSubmit={async (v) => {
                    await save("leads", {
                      ...v,
                      propertyId: p.id,
                      kind: "Visit",
                      status: "New",
                      notes: "",
                    });
                  }}
                />
              )}
              <p className="form-note">
                <ShieldCheck size={15} /> Availability is confirmed during
                booking.
              </p>
            </Panel>
          </aside>
        </div>
      </section>
    </PublicLayout>
  );
}
export function BookingPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { data, action } = useApp();
  const p = data.properties.find((p) => p.id === id);
  const [sharing, setSharing] = useState(
    ["single", "double", "triple"].includes(params.get("sharing") || "")
      ? params.get("sharing")!
      : "double",
  );
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [hold, setHold] = useState<{
    id: string;
    expiresAt: string;
    amount: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = hold
    ? Math.max(0, Math.floor((new Date(hold.expiresAt).getTime() - now) / 1000))
    : 0;
  const expired = !!hold && remaining === 0;
  if (!p)
    return (
      <PublicLayout>
        <section className="section container">
          <DataStatus />
          <Empty
            title="Select a residence first"
            action={
              <Link to="/explore" className="btn">
                Explore homes
              </Link>
            }
          />
        </section>
      </PublicLayout>
    );
  const room = p.rooms[sharing] || p.rooms.double;
  async function proceed(v: Record<string, string>) {
    setError("");
    setBusy(true);
    try {
      if (v.moveIn < today()) throw new Error("Choose a future move-in date.");
      setDetails(v);
      if (DEMO)
        setHold({
          id: "preview-hold",
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          amount: room.price,
        });
      else {
        const h = await request<{
          id: string;
          expiresAt: string;
          amount: number;
        }>("/holds", {
          method: "POST",
          body: { propertyId: p!.id, sharing, moveIn: v.moveIn },
          key: crypto.randomUUID(),
        });
        setHold(h);
      }
      setStep(2);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <PublicLayout>
      <section className="container section">
        <PageHead
          eyebrow="YOUR NEXT CHAPTER"
          title="Let’s get you settled."
          description="Choose a room, tell us about yourself and review your booking."
        />
        <div className="steps">
          {["Your room", "Your details", "Review & pay"].map((s, i) => (
            <span
              className={step === i ? "active" : step > i ? "complete" : ""}
              key={s}
            >
              <b>{i + 1}</b>
              {s}
            </span>
          ))}
        </div>
        {done ? (
          <Panel>
            <div className="success">
              <Check size={38} />
              <h2>Booking preview completed.</h2>
              <p>No bed was reserved and no payment was collected.</p>
              <Link className="btn" to="/explore">
                Back to homes
              </Link>
            </div>
          </Panel>
        ) : (
          <div className="detail-grid">
            <Panel>
              <h2>
                {
                  [
                    "Find your perfect fit.",
                    "A few details about you.",
                    "Check everything looks right.",
                  ][step]
                }
              </h2>
              {error && <Alert>{error}</Alert>}
              {step === 0 && (
                <>
                  <div className="room-options">
                    {Object.entries(p.rooms).map(([key, r]) => (
                      <label
                        className={
                          "room-radio " + (sharing === key ? "selected" : "")
                        }
                        key={key}
                      >
                        <input
                          type="radio"
                          name="sharing"
                          checked={sharing === key}
                          disabled={!r.left}
                          onChange={() => setSharing(key)}
                        />
                        <span>
                          <b>{key} sharing</b>
                          <small>
                            {r.left
                              ? "Furnished room · meals included"
                              : "Unavailable"}
                          </small>
                        </span>
                        <strong>{money(r.price)}</strong>
                      </label>
                    ))}
                  </div>
                  <button
                    className="btn"
                    disabled={!room?.left}
                    onClick={() => setStep(1)}
                  >
                    Continue <ArrowRight size={16} />
                  </button>
                </>
              )}
              {step === 1 && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void proceed(
                      Object.fromEntries(
                        new FormData(e.currentTarget),
                      ) as Record<string, string>,
                    );
                  }}
                >
                  <Fields
                    fields={[
                      ...contactFields,
                      {
                        name: "moveIn",
                        label: "Move-in date",
                        type: "date",
                        required: true,
                        min: today(),
                      },
                      {
                        name: "occupation",
                        label: "Occupation",
                        required: true,
                        options: [
                          {
                            label: "Working professional",
                            value: "Professional",
                          },
                          { label: "Student", value: "Student" },
                        ],
                      },
                    ]}
                    defaults={details}
                  />
                  <p className="form-note">
                    Identity verification will be requested securely after your
                    booking details are reviewed.
                  </p>
                  <div className="button-row">
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => setStep(0)}
                    >
                      Back
                    </button>
                    <button className="btn" disabled={busy}>
                      {busy ? "Checking availability…" : "Review booking"}
                      <ArrowRight size={17} />
                    </button>
                  </div>
                </form>
              )}
              {step === 2 && (
                <>
                  <div className="review-grid">
                    <span>
                      Name<b>{details.name}</b>
                    </span>
                    <span>
                      Contact<b>{details.phone}</b>
                    </span>
                    <span>
                      Move in<b>{details.moveIn}</b>
                    </span>
                    <span>
                      Room<b>{sharing} sharing</b>
                    </span>
                  </div>
                  <div className={"hold-banner " + (expired ? "expired" : "")}>
                    <Clock size={18} />
                    {expired
                      ? "Your hold has expired. Please check availability again."
                      : `${DEMO ? "Preview timer" : "Bed hold"} · ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} remaining`}
                  </div>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      setError("");
                      try {
                        if (DEMO) {
                          await action("booking-preview", {
                            propertyId: p.id,
                            sharing,
                            ...details,
                          });
                          setDone(true);
                        } else {
                          const r = await request<{ checkoutUrl: string }>(
                            "/payment-orders",
                            {
                              method: "POST",
                              body: { holdId: hold?.id, ...details },
                              key: crypto.randomUUID(),
                            },
                          );
                          const url = safeExternalUrl(r.checkoutUrl);
                          if (!url)
                            throw new Error(
                              "The checkout link could not be verified.",
                            );
                          window.location.assign(url);
                        }
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <label className="check-row">
                      <input type="checkbox" required />I have reviewed the{" "}
                      <Link to="/legal" target="_blank">
                        stay terms and cancellation policy
                      </Link>
                      .
                    </label>
                    <div className="button-row">
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => {
                          setStep(1);
                          setHold(null);
                        }}
                      >
                        Check again
                      </button>
                      <button className="btn" disabled={expired || busy}>
                        {busy
                          ? "Opening checkout…"
                          : DEMO
                            ? "Complete preview"
                            : "Continue to payment"}
                        <LockKeyhole size={16} />
                      </button>
                    </div>
                  </form>
                </>
              )}
            </Panel>
            <aside>
              <Panel title="Your new address">
                <img className="summary-image" src={p.img} alt={p.name} />
                <h3>{p.name}</h3>
                <p>{p.area}</p>
                <div className="line-item">
                  <span>{sharing} sharing / month</span>
                  <b>{money(room?.price || 0)}</b>
                </div>
                <div className="line-item">
                  <span>
                    {hold ? "Amount due now" : "Estimated monthly rent"}
                  </span>
                  <b>{money(hold?.amount ?? room?.price ?? 0)}</b>
                </div>
                <p className="form-note">
                  {DEMO
                    ? "Preview prices come from the original design."
                    : "Final amount and fees are returned by the booking service."}{" "}
                  A payment is confirmed only after verification.
                </p>
              </Panel>
            </aside>
          </div>
        )}
      </section>
    </PublicLayout>
  );
}
export function LoginPage() {
  const { session, loginDemo, login } = useApp();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>("resident");
  const [challenge, setChallenge] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (session)
      navigate(
        `/${session.role}/${session.role === "resident" ? "home" : "overview"}`,
        { replace: true },
      );
  }, [session, navigate]);
  useEffect(() => {
    if (cooldown) {
      const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [cooldown]);
  return (
    <PublicLayout>
      <section className="login-section container">
        <div className="login-story">
          <img
            src="/images/residents-work.jpg"
            alt="Residents working together in a shared space"
          />
          <div>
            <span className="eyebrow">EVERYTHING, IN ONE PLACE</span>
            <h1>
              Welcome
              <br />
              back home.
            </h1>
            <p>Your stay. Your payments. Your people.</p>
          </div>
        </div>
        <Panel className="login-panel">
          <span className="eyebrow">YOUR SEHRAWAT SPACE</span>
          <h2>Good to see you.</h2>
          <p>Choose your portal to sign in.</p>
          <div className="segmented">
            {(["resident", "corporate", "owner"] as Role[]).map((r) => (
              <button
                className={role === r ? "active" : ""}
                key={r}
                onClick={() => {
                  setRole(r);
                  setChallenge("");
                  setError("");
                }}
              >
                {r}
              </button>
            ))}
          </div>
          {DEMO ? (
            <div className="demo-login">
              <ShieldCheck size={30} />
              <h3>Explore the {role} experience</h3>
              <p>
                This is a frontend preview using fictional records. Secure
                authentication will be provided by the separate backend.
              </p>
              <button
                className="btn full-width"
                onClick={() => loginDemo(role)}
              >
                Open {role} preview <ArrowRight size={17} />
              </button>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                const v = Object.fromEntries(
                  new FormData(e.currentTarget),
                ) as Record<string, string>;
                try {
                  if (role === "owner" && !challenge) {
                    const r = await request<{ challengeId: string }>(
                      "/auth/otp/request",
                      { method: "POST", body: { phone: v.phone } },
                    );
                    setChallenge(r.challengeId);
                    setCooldown(60);
                  } else await login({ ...v, role, challengeId: challenge });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Fields
                fields={
                  role === "owner"
                    ? challenge
                      ? [
                          {
                            name: "otp",
                            label: "6-digit verification code",
                            required: true,
                            placeholder: "Enter your code",
                          },
                        ]
                      : [
                          {
                            name: "phone",
                            label: "Owner mobile number",
                            type: "tel",
                            required: true,
                          },
                        ]
                    : [
                        {
                          name: "email",
                          label: "Email address",
                          type: "email",
                          required: true,
                        },
                        {
                          name: "password",
                          label: "Password",
                          type: "password",
                          required: true,
                        },
                      ]
                }
              />
              {error && <Alert>{error}</Alert>}
              <button className="btn full-width" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : role === "owner" && !challenge
                    ? "Send verification code"
                    : "Sign in"}
                <ArrowRight size={16} />
              </button>
              {challenge && (
                <button
                  type="button"
                  className="text-link"
                  disabled={cooldown > 0}
                  onClick={() => setChallenge("")}
                >
                  {cooldown
                    ? `Request another code in ${cooldown}s`
                    : "Request another code"}
                </button>
              )}
              <Link className="text-link" to="/recover">
                Need help signing in?
              </Link>
            </form>
          )}
          <p className="form-note">
            Access is limited to records assigned to your account.
          </p>
        </Panel>
      </section>
    </PublicLayout>
  );
}
export function RecoveryPage() {
  return (
    <PublicLayout>
      <section className="container section narrow">
        <Panel
          title="Recover your account"
          description="Enter your email to request a recovery link."
        >
          <SubmitForm
            fields={[
              {
                name: "email",
                label: "Email address",
                type: "email",
                required: true,
              },
            ]}
            submit="Request recovery"
            success="If this account exists, recovery instructions will be sent."
            onSubmit={async (v) => {
              if (!DEMO)
                await request("/auth/recover", { method: "POST", body: v });
            }}
          />
          <p className="form-note">
            Owner phone recovery requires verification with the property
            administrator.
          </p>
        </Panel>
      </section>
    </PublicLayout>
  );
}
export function InfoPage({
  kind,
}: {
  kind: "corporate" | "partner" | "about" | "safety" | "legal";
}) {
  const { save } = useApp();
  const content = {
    corporate: {
      eyebrow: "HOMES THAT WORK FOR YOUR TEAM",
      title: "A smoother move.\nA stronger start.",
      description:
        "Help your people settle into a new city, with managed accommodation and one company portal.",
      image: "corporate-team",
      features: [
        [
          "Team accommodation",
          "Request beds together, manage employees and track allocations.",
        ],
        [
          "Clear monthly billing",
          "Review consolidated invoices and outstanding balances.",
        ],
        [
          "One point of support",
          "Stay updated on housing requests and employee stays.",
        ],
      ],
    },
    partner: {
      eyebrow: "LET YOUR PROPERTY DO MORE",
      title: "Your property.\nOur everyday care.",
      description:
        "Bring your property to Sehrawat PG and start a conversation about managed living.",
      image: "building",
      features: [
        [
          "Organised operations",
          "Residents, rent and maintenance in a shared workspace.",
        ],
        [
          "Thoughtful presentation",
          "A clear listing with photos, amenities and room options.",
        ],
        [
          "Visibility that matters",
          "Understand occupancy, collections and everyday performance.",
        ],
      ],
    },
    about: {
      eyebrow: "A LITTLE CLOSER TO HOME",
      title: "Built around\nthe way you live.",
      description:
        "We believe moving to a new city should feel exciting. Your home should help you settle in.",
      image: "community",
      features: [
        [
          "Spaces with purpose",
          "Room to focus, space to unwind and people to connect with.",
        ],
        [
          "Everyday essentials",
          "Furnished rooms, familiar meals and practical amenities.",
        ],
        [
          "Care that shows up",
          "A clear way to ask for help and follow your requests.",
        ],
      ],
    },
    safety: {
      eyebrow: "FEEL SETTLED. FEEL SUPPORTED.",
      title: "Care is in\nthe everyday details.",
      description:
        "Clear house rules, managed properties and support you can reach from your resident portal.",
      image: "maintenance",
      features: [
        [
          "Property-specific facilities",
          "Check each listing and verify safety facilities during your visit.",
        ],
        [
          "Private resident access",
          "Your stay, invoices and documents belong in your account.",
        ],
        [
          "Trackable support",
          "Raise a complaint, share the details and follow its progress.",
        ],
      ],
    },
    legal: {
      eyebrow: "CLEAR FROM THE START",
      title: "Terms, privacy\nand your stay.",
      description:
        "Review your property-specific agreement before making a booking or payment.",
      image: "living-3",
      features: [
        [
          "Bookings and payment",
          "Room availability and final charges must be verified by the booking service. A payment callback alone is not a confirmed stay.",
        ],
        [
          "Cancellation and refunds",
          "The approved cancellation, notice and refund terms must be provided in your agreement before payment.",
        ],
        [
          "Personal information",
          "Contact and stay details are used to manage your request and tenancy. Private documents must be accessed through your account.",
        ],
      ],
    },
  }[kind];
  return (
    <PublicLayout>
      <section className="section container">
        <div className="split info-hero">
          <div>
            <span className="eyebrow">{content.eyebrow}</span>
            <h1>
              {content.title.split("\n").map((s, i) => (
                <span key={i}>
                  {s}
                  <br />
                </span>
              ))}
            </h1>
            <p className="lead">{content.description}</p>
            {(kind === "corporate" || kind === "partner") && (
              <a className="btn" href="#enquire">
                Let’s talk <ArrowRight size={17} />
              </a>
            )}
          </div>
          <img
            className="rounded-photo"
            src={"/images/" + content.image + ".jpg"}
            alt="Life at Sehrawat PG"
          />
        </div>
        <div className="info-features">
          {content.features.map(([t, d], i) => (
            <Panel key={t}>
              <span className="feature-number">0{i + 1}</span>
              <h3>{t}</h3>
              <p>{d}</p>
            </Panel>
          ))}
        </div>
        {(kind === "corporate" || kind === "partner") && (
          <div className="split section" id="enquire">
            <div>
              <span className="eyebrow">START A CONVERSATION</span>
              <h2>
                {kind === "corporate"
                  ? "Let’s make room for your team."
                  : "Tell us about your property."}
              </h2>
              <p>
                Share a few details and we’ll follow up to discuss the next
                steps.
              </p>
              {kind === "corporate" && (
                <Link className="text-link" to="/login">
                  Already a partner? Sign in <ArrowUpRight size={16} />
                </Link>
              )}
            </div>
            <Panel>
              <SubmitForm
                fields={[
                  ...contactFields,
                  {
                    name: kind === "corporate" ? "company" : "address",
                    label:
                      kind === "corporate"
                        ? "Company name"
                        : "Property address",
                    required: true,
                  },
                  {
                    name: "capacity",
                    label:
                      kind === "corporate"
                        ? "Beds required"
                        : "Property capacity",
                    type: "number",
                    min: 1,
                    max: 500,
                    required: true,
                  },
                  {
                    name: "notes",
                    label: "Anything else we should know?",
                    type: "textarea",
                  },
                ]}
                onSubmit={async (v) => {
                  await save("leads", {
                    ...v,
                    kind:
                      kind === "corporate" ? "Corporate" : "Property partner",
                    status: "New",
                    date: today(),
                    propertyId: "",
                  });
                }}
              />
            </Panel>
          </div>
        )}
        {kind === "legal" && (
          <Panel title="Client approval required before launch">
            <p>
              This frontend contains an outline, not final legal policies. The
              property operator must supply its legal name, contact information,
              retention rules, cancellation terms and signed agreement. Online
              payments must remain disabled until these are approved.
            </p>
          </Panel>
        )}
      </section>
    </PublicLayout>
  );
}
export function NotFound() {
  return (
    <PublicLayout>
      <section className="container section">
        <Empty
          title="This page has moved."
          text="Let’s find your way home."
          action={
            <Link className="btn" to="/">
              Back to home <ArrowRight size={17} />
            </Link>
          }
        />
      </section>
    </PublicLayout>
  );
}
