import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("../api", async () => ({
  ...(await vi.importActual("../api")),
  DEMO: true,
}));
import { App } from "../main";
async function owner() {
  window.history.replaceState({}, "", "/login");
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "owner" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Open owner preview" }),
  );
  await screen.findByRole("heading", { name: "A good day starts here." });
}
describe("frontend journeys", () => {
  it("completes a preview booking without claiming a real reservation", async () => {
    window.history.replaceState({}, "", "/book/lotus?sharing=double");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(screen.getByLabelText("Full name *"), "Preview Guest");
    await userEvent.type(screen.getByLabelText("Phone number *"), "9000000088");
    await userEvent.type(screen.getByLabelText("Email *"), "guest@example.com");
    const date = screen.getByLabelText("Move-in date *");
    await userEvent.type(
      date,
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Occupation *"),
      "Professional",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Review booking" }),
    );
    expect(await screen.findByText(/Preview timer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: "Complete preview" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Booking preview completed.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No bed was reserved and no payment was collected."),
    ).toBeInTheDocument();
  });
  it("renders all resident destinations and supports mobile menu state", async () => {
    window.history.replaceState({}, "", "/login");
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "Open resident preview" }),
    );
    await screen.findByRole("heading", { name: "Welcome home, Rohit." });
    const menu = screen.getByRole("button", { name: "Open portal navigation" });
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "Portal navigation" });
    for (const name of [
      "Rent & bills",
      "Food menu",
      "My documents",
      "Refer a friend",
      "Move out",
    ]) {
      await userEvent.click(within(nav).getByRole("link", { name }));
      expect(
        screen.queryByText("Something didn’t load."),
      ).not.toBeInTheDocument();
    }
    expect(menu).toHaveAttribute("aria-expanded", "false");
  });
  it("searches homes and opens the correct property", async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText("Search locality"), "Sector 45");
    await userEvent.click(screen.getByRole("button", { name: "Find a home" }));
    await screen.findByText("1 homes to explore");
    await userEvent.click(screen.getByRole("link", { name: "Sehrawat Lotus" }));
    expect(
      await screen.findByRole("heading", { name: "Sehrawat Lotus" }),
    ).toBeInTheDocument();
  });
  it("gates owner routes behind login", async () => {
    window.history.replaceState({}, "", "/owner/rent");
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Good to see you." }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Keep collections clear."),
    ).not.toBeInTheDocument();
  });
  it("opens all owner navigation screens without rendering errors", async () => {
    await owner();
    const nav = screen.getByRole("navigation", { name: "Portal navigation" });
    for (const label of [
      "Residents",
      "Rooms & beds",
      "Rent & payments",
      "Resident insights",
      "Leads & visits",
      "Complaints",
      "Shared inbox",
      "Campaigns",
      "Automated messages",
      "Agreements",
      "Financial reports",
      "Properties",
      "Settings",
    ]) {
      await userEvent.click(within(nav).getByRole("link", { name: label }));
      await waitFor(() =>
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1),
      );
      expect(
        screen.queryByText("Something didn’t load."),
      ).not.toBeInTheDocument();
    }
  });
  it("creates and searches a resident profile", async () => {
    await owner();
    await userEvent.click(screen.getByRole("link", { name: "Residents" }));
    await userEvent.click(screen.getByRole("button", { name: "Add resident" }));
    const d = screen.getByRole("dialog");
    await userEvent.type(
      within(d).getByLabelText("Full name *"),
      "Test Resident",
    );
    await userEvent.type(
      within(d).getByLabelText("Email address *"),
      "test@example.com",
    );
    await userEvent.type(within(d).getByLabelText("Phone *"), "9000000044");
    await userEvent.selectOptions(
      within(d).getByLabelText("Property *"),
      "lotus",
    );
    await userEvent.type(
      within(d).getByLabelText("Room / bed label *"),
      "301A",
    );
    await userEvent.type(
      within(d).getByLabelText("Monthly rent (₹) *"),
      "12000",
    );
    await userEvent.click(
      within(d).getByRole("button", { name: "Save changes" }),
    );
    await screen.findByText("Test Resident");
    await userEvent.type(
      screen.getByLabelText("Search name, email or room"),
      "Test Resident",
    );
    expect(screen.getByText("1 records · Page 1 of 1")).toBeInTheDocument();
  });
  it("records a partial rent receipt without clearing the invoice", async () => {
    await owner();
    await userEvent.click(
      screen.getByRole("link", { name: "Rent & payments" }),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Record receipt" })[0],
    );
    const d = screen.getByRole("dialog");
    const amount = within(d).getByLabelText("Amount received (₹) *");
    await userEvent.clear(amount);
    await userEvent.type(amount, "1000");
    await userEvent.selectOptions(
      within(d).getByLabelText("Method *"),
      "Bank transfer",
    );
    await userEvent.type(
      within(d).getByLabelText("Bank / receipt reference *"),
      "BANK-001",
    );
    await userEvent.click(
      within(d).getByRole("button", { name: "Save changes" }),
    );
    expect(await screen.findByText("Part paid")).toBeInTheDocument();
  });
  it("hands bot conversation to staff before a reply", async () => {
    await owner();
    await userEvent.click(screen.getByRole("link", { name: "Shared inbox" }));
    await userEvent.click(screen.getByRole("button", { name: /Priya Sharma/ }));
    expect(screen.getByLabelText("Write your reply")).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText("Conversation mode"),
      "Human",
    );
    await userEvent.type(
      screen.getByLabelText("Write your reply"),
      "Hello, happy to help.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(
      await within(screen.getByRole("log")).findByText("Hello, happy to help."),
    ).toBeInTheDocument();
  });
  it("keeps corporate users in the corporate workspace", async () => {
    window.history.replaceState({}, "", "/login");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "corporate" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Open corporate preview" }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Welcome, Acme Technologies.",
      }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Portal navigation" });
    for (const label of [
      "Employees & beds",
      "Company invoices",
      "Housing requests",
      "Agreements",
    ]) {
      await userEvent.click(within(nav).getByRole("link", { name: label }));
      expect(
        screen.queryByText("Something didn’t load."),
      ).not.toBeInTheDocument();
    }
    expect(
      within(nav).queryByRole("link", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  it("resident complaint appears in their own workspace", async () => {
    window.history.replaceState({}, "", "/login");
    render(<App />);
    await userEvent.click(
      screen.getByRole("button", { name: "Open resident preview" }),
    );
    await screen.findByRole("heading", { name: "Welcome home, Rohit." });
    await userEvent.click(
      screen.getByRole("link", { name: "Help & complaints" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "New request" }));
    const d = screen.getByRole("dialog");
    await userEvent.type(
      within(d).getByLabelText("Subject *"),
      "Internet outage",
    );
    await userEvent.selectOptions(
      within(d).getByLabelText("Category *"),
      "Internet",
    );
    await userEvent.type(
      within(d).getByLabelText("Describe the issue *"),
      "WiFi is unavailable in my room.",
    );
    await userEvent.click(
      within(d).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Internet outage" }),
    ).toBeInTheDocument();
  });
});
