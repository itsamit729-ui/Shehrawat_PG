import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const api = vi.hoisted(() => ({
  request: vi.fn(),
  overrides: {} as Record<string, () => Promise<unknown>>,
}));
vi.mock("../api", async () => ({
  ...(await vi.importActual("../api")),
  DEMO: false,
  request: api.request,
  resetCsrf: vi.fn(),
}));
import { ApiError } from "../api";
import { App } from "../main";

const owner = { id: "u1", name: "Amit", role: "owner" };
const property = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Sehrawat Lotus",
  area: "Sector 45",
  sector: "Near metro",
  gender: "Women",
  audience: "Students",
  food: true,
  ac: true,
  rating: 4.5,
  reviews: 10,
  img: "/images/room.jpg",
  gallery: [],
  landmarks: [],
  rooms: { double: { price: 14299, left: 3 } },
  amenities: [],
  beds: 3,
  occupied: 0,
  blurb: "A home",
};
const resident = (name: string, status: string) => ({
  id: name,
  name,
  email: `${name}@example.com`,
  phone: "9811111111",
  propertyId: property.id,
  room: "101A",
  rent: 14299,
  status,
  joined: "2026-10-01",
});
const portal = {
  residents: [resident("Priya", "Active"), resident("Neha", "Notice")],
};

let signedIn = true;
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
const calls = (path: string) =>
  api.request.mock.calls.filter(([p]) => p === path).length;

beforeEach(() => {
  signedIn = true;
  api.overrides = {};
  vi.unstubAllEnvs();
  vi.stubEnv("VITE_OWNER_LOGIN", "otp");
  api.request.mockReset();
  api.request.mockImplementation((path: string) => {
    if (api.overrides[path]) return api.overrides[path]();
    if (path === "/properties") return Promise.resolve([property]);
    if (path === "/portal") return Promise.resolve(portal);
    if (path === "/auth/session")
      return signedIn
        ? Promise.resolve({ ...owner, csrfToken: "t" })
        : Promise.reject(new ApiError("Please sign in.", 401));
    if (path === "/auth/otp/request")
      return Promise.resolve({ challengeId: "c1" });
    if (path === "/auth/login") {
      signedIn = true;
      return Promise.resolve({ user: owner });
    }
    return Promise.resolve(null);
  });
});

async function openResidents() {
  window.history.replaceState({}, "", "/owner/residents");
  render(<App />);
  await screen.findByRole("heading", { name: "People make a place." });
}
async function saveNeha() {
  await userEvent.click(screen.getByRole("button", { name: "Notice" }));
  await userEvent.click(screen.getByRole("button", { name: /View \/ edit/ }));
  const dialog = screen.getByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
}

describe("live mode after a save", () => {
  it("keeps the screen and its filter mounted while data reloads", async () => {
    await openResidents();
    const portalLoad = deferred();
    api.overrides["/portal"] = () => portalLoad.promise;
    await saveNeha();
    await waitFor(() => expect(calls("/portal")).toBeGreaterThan(1));
    expect(screen.queryByText("Loading your workspace…")).toBeNull();
    expect(screen.getByRole("button", { name: "Notice" })).toHaveClass(
      "active",
    );
    portalLoad.resolve(portal);
    await screen.findByText("Changes saved.");
    expect(screen.getByRole("button", { name: "Notice" })).toHaveClass(
      "active",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Neha")).toBeInTheDocument();
  });

  it("keeps the data on screen if only the reload fails", async () => {
    await openResidents();
    api.overrides["/portal"] = () =>
      Promise.reject(new ApiError("Unavailable", 503));
    await saveNeha();
    await screen.findByText(/Saved, but the latest data/);
    expect(screen.getByText("Neha")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("shows a failed save in the form and stays put", async () => {
    await openResidents();
    api.overrides["/residents/Neha"] = () =>
      Promise.reject(new ApiError("That email is already in use.", 409));
    await saveNeha();
    await screen.findByText("That email is already in use.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("sends an expired session to sign in, then back to the same page", async () => {
    await openResidents();
    api.overrides["/residents/Neha"] = () => {
      signedIn = false;
      return Promise.reject(new ApiError("Please sign in.", 401));
    };
    await saveNeha();
    await screen.findByRole("heading", { name: "Good to see you." });
    expect(screen.getByText(/Your session has ended/)).toBeInTheDocument();
    expect(screen.queryByText("Neha")).toBeNull();
    await signInAsOwner();
    await screen.findByRole("heading", { name: "People make a place." });
    expect(window.location.pathname).toBe("/owner/residents");
  });
});

async function signInAsOwner() {
  await userEvent.click(screen.getByRole("button", { name: "owner" }));
  await userEvent.type(
    screen.getByLabelText(/Owner mobile number/),
    "9876543210",
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Send verification code/ }),
  );
  await userEvent.type(
    await screen.findByLabelText(/6-digit verification code/),
    "123456",
  );
  await userEvent.click(screen.getByRole("button", { name: /Sign in/ }));
}

describe("live mode sign-in", () => {
  it("returns to the page that required sign-in", async () => {
    signedIn = false;
    window.history.replaceState({}, "", "/owner/residents");
    render(<App />);
    await screen.findByRole("heading", { name: "Good to see you." });
    await signInAsOwner();
    await screen.findByRole("heading", { name: "People make a place." });
    expect(window.location.pathname).toBe("/owner/residents");
  });

  it("ignores a return page from another role's portal", async () => {
    signedIn = false;
    window.history.replaceState({ usr: { from: "/resident/home" } }, "", "/login");
    render(<App />);
    await screen.findByRole("heading", { name: "Good to see you." });
    await signInAsOwner();
    await screen.findByRole("heading", { name: "A good day starts here." });
    expect(window.location.pathname).toBe("/owner/overview");
  });
});

describe("owner sign-in without SMS", () => {
  it("asks only for a password, and never requests a code", async () => {
    vi.stubEnv("VITE_OWNER_LOGIN", "password");
    signedIn = false;
    window.history.replaceState({}, "", "/owner/residents");
    render(<App />);
    await screen.findByRole("heading", { name: "Good to see you." });
    await userEvent.click(screen.getByRole("button", { name: "owner" }));
    expect(screen.queryByLabelText(/Owner mobile number/)).toBeNull();
    await userEvent.type(screen.getByLabelText(/Owner password/), "secret-value");
    await userEvent.click(screen.getByRole("button", { name: /Sign in/ }));
    await screen.findByRole("heading", { name: "People make a place." });
    expect(calls("/auth/otp/request")).toBe(0);
    const login = api.request.mock.calls.find(([p]) => p === "/auth/login");
    expect(login?.[1].body).toMatchObject({
      role: "owner",
      password: "secret-value",
    });
  });
});

describe("old prototype links", () => {
  async function visit(url: string) {
    signedIn = false;
    window.history.replaceState({}, "", url);
    render(<App />);
    await waitFor(() =>
      expect(window.location.pathname).not.toMatch(/\.html$/),
    );
    return window.location.pathname + window.location.search + window.location.hash;
  }
  it("keeps filters and anchors", async () => {
    expect(await visit("/explore.html?gender=Women")).toBe(
      "/explore?gender=Women",
    );
  });
  it("keeps the section of a page", async () => {
    expect(await visit("/legal.html#refund")).toBe("/legal#refund");
  });
  it("opens the same property", async () => {
    expect(await visit("/property.html?id=lotus")).toBe("/properties/lotus");
  });
  it("opens booking for the same property", async () => {
    expect(await visit("/book.html?property=lotus")).toBe("/book/lotus");
  });
  it("sends booking without a property to the listings", async () => {
    expect(await visit("/book.html?mode=visit")).toBe("/explore");
  });
});

describe("page titles", () => {
  it("never shows a raw record ID", async () => {
    window.history.replaceState({}, "", `/properties/${property.id}`);
    render(<App />);
    await screen.findByRole("heading", { name: property.name });
    expect(document.title).toBe("properties · Sehrawat PG");
  });
});
