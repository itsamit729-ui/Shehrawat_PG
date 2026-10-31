import { ProviderRejected, type PaymentLink, type PaymentProvider } from "./index.js";

const BASE = "https://api.razorpay.com/v1";

interface RawLink {
  id: string;
  short_url: string;
  status: string;
  currency: string;
  payments?: { payment_id: string; amount: number; status: string }[] | null;
}

const toLink = (raw: RawLink): PaymentLink => ({
  id: raw.id,
  url: raw.short_url,
  status: raw.status,
  payments: (raw.payments ?? []).map((p) => ({
    id: p.payment_id,
    amountPaise: p.amount,
    currency: raw.currency,
    captured: p.status === "captured",
  })),
});

export function createRazorpay(keyId: string, keySecret: string): PaymentProvider {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(BASE + path, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    // A 4xx is a definite refusal. Anything else may have taken effect, and callers reconcile it.
    if (response.status >= 400 && response.status < 500) throw new ProviderRejected(response.status);
    if (!response.ok) throw new Error(`Razorpay answered ${response.status}`);
    return (await response.json()) as T;
  }
  return {
    async createPaymentLink(input) {
      return toLink(
        await api<RawLink>("POST", "/payment_links", {
          amount: input.amountPaise,
          currency: "INR",
          accept_partial: false,
          reference_id: input.referenceId,
          description: input.description,
          ...(input.customer
            ? { customer: { name: input.customer.name, email: input.customer.email, contact: input.customer.phone } }
            : {}),
          ...(input.expiresInSeconds ? { expire_by: Math.floor(Date.now() / 1000) + input.expiresInSeconds } : {}),
          notify: { sms: false, email: false },
          reminder_enable: false,
          callback_url: input.callbackUrl,
          callback_method: "get",
        }),
      );
    },
    async findPaymentLink(referenceId) {
      const { payment_links: links } = await api<{ payment_links: RawLink[] }>(
        "GET",
        `/payment_links?reference_id=${encodeURIComponent(referenceId)}`,
      );
      return links[0] ? toLink(links[0]) : null;
    },
    fetchPaymentLink: async (id) => toLink(await api<RawLink>("GET", `/payment_links/${encodeURIComponent(id)}`)),
    // Razorpay treats a repeated receipt on a payment as a duplicate, so a retry can't pay twice.
    refund: (input) =>
      api<{ id: string; status: string }>("POST", `/payments/${encodeURIComponent(input.paymentId)}/refund`, {
        amount: input.amountPaise,
        receipt: input.receipt,
      }),
  };
}
