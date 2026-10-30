export type Role = "owner" | "resident" | "corporate";
export interface Session {
  id: string;
  name: string;
  role: Role;
  residentId?: string;
  corporateId?: string;
}
export interface RoomType {
  price: number;
  left: number;
}
export interface Property {
  id: string;
  name: string;
  area: string;
  sector: string;
  gender: string;
  audience: string;
  food: boolean;
  ac: boolean;
  rating: number;
  reviews: number;
  img: string;
  gallery: string[];
  landmarks: string[][];
  rooms: Record<string, RoomType>;
  amenities: string[];
  beds: number;
  occupied: number;
  blurb: string;
}
export interface Resident {
  id: string;
  name: string;
  email: string;
  phone: string;
  propertyId: string;
  room: string;
  rent: number;
  status: string;
  joined: string;
  corporateId?: string;
}
export interface Invoice {
  id: string;
  residentId: string;
  corporateId?: string;
  period: string;
  due: string;
  amount: number;
  paid: number;
  status: string;
  description: string;
}
export interface Ticket {
  id: string;
  residentId: string;
  subject: string;
  category: string;
  description: string;
  status: string;
  priority: string;
  created: string;
  assignee: string;
}
export interface Lead {
  id: string;
  name: string;
  phone: string;
  email: string;
  propertyId: string;
  date: string;
  status: string;
  notes: string;
  kind: string;
}
export interface Agreement {
  id: string;
  residentId: string;
  title: string;
  status: string;
  created: string;
  url?: string;
}
export interface Campaign {
  id: string;
  name: string;
  template: string;
  audience: string;
  scheduled: string;
  status: string;
  recipients: number;
  delivered: number;
}
export interface Message {
  id: string;
  body: string;
  sender: "customer" | "staff" | "bot";
  time: string;
  status: string;
}
export interface Conversation {
  id: string;
  name: string;
  residentId: string;
  mode: string;
  assignee: string;
  lastInbound: string;
  messages: Message[];
}
export interface Expense {
  id: string;
  category: string;
  description: string;
  amount: number;
  date: string;
}
export interface Allocation {
  id: string;
  corporateId: string;
  employee: string;
  propertyId: string;
  room: string;
  start: string;
  end: string;
  status: string;
}
export interface Bed {
  id: string;
  propertyId: string;
  room: string;
  type: string;
  status: string;
  residentId?: string;
}
export interface RecordItem {
  id: string;
  [key: string]: unknown;
}
export interface DataState {
  beds: Bed[];
  properties: Property[];
  residents: Resident[];
  invoices: Invoice[];
  tickets: Ticket[];
  leads: Lead[];
  agreements: Agreement[];
  campaigns: Campaign[];
  conversations: Conversation[];
  expenses: Expense[];
  allocations: Allocation[];
  requests: RecordItem[];
  payments: RecordItem[];
  settings: Record<string, unknown>;
}
export type Collection = Exclude<keyof DataState, "settings">;
export const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
export const today = () => new Date().toISOString().slice(0, 10);
export const formatDate = (s: string) =>
  s
    ? new Date(s).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
export const minPrice = (p: Property) =>
  Math.min(...Object.values(p.rooms).map((r) => r.price));
export function filterProperties(
  list: Property[],
  q: string,
  gender: string,
  budget: number,
  sharing: string,
) {
  return list.filter(
    (p) =>
      (!q ||
        `${p.name} ${p.area} ${p.sector}`
          .toLowerCase()
          .includes(q.toLowerCase())) &&
      (!gender || p.gender === gender) &&
      (!sharing || !!p.rooms[sharing]) &&
      (sharing ? p.rooms[sharing]?.price : minPrice(p)) <= budget,
  );
}
export function invoiceBalance(i: Invoice) {
  return Math.max(0, i.amount - i.paid);
}
export function applyReceipt(invoice: Invoice, amount: number): Invoice {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > invoiceBalance(invoice)
  )
    throw new Error(
      "Enter an amount above zero and no higher than the balance.",
    );
  const paid = invoice.paid + amount;
  return {
    ...invoice,
    paid,
    status: paid === invoice.amount ? "Paid" : "Part paid",
  };
}
export function canReply(lastInbound: string, now = Date.now()) {
  return now - new Date(lastInbound).getTime() < 24 * 60 * 60 * 1000;
}
export function csvText(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return [
    keys.map(cell).join(","),
    ...rows.map((row) => keys.map((k) => cell(row[k])).join(",")),
  ].join("\r\n");
}
export function downloadCSV(name: string, rows: Record<string, unknown>[]) {
  const u = URL.createObjectURL(
    new Blob(["\uFEFF" + csvText(rows)], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
export function safeExternalUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
