import { ProviderRejected, type WhatsAppProvider } from "./index.js";

const BASE = "https://graph.facebook.com/v23.0";

export function createWhatsApp(config: {
  token: string;
  phoneNumberId: string;
  businessAccountId: string;
}): WhatsAppProvider {
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(BASE + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 400 && response.status < 500) throw new ProviderRejected(response.status);
    if (!response.ok) throw new Error(`WhatsApp answered ${response.status}`);
    return (await response.json()) as T;
  }
  const send = async (message: Record<string, unknown>) => {
    const { messages } = await api<{ messages: { id: string }[] }>(`/${config.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      ...message,
    });
    return { id: messages[0]!.id };
  };
  return {
    sendText: (to, body) => send({ to: to.replace("+", ""), type: "text", text: { body } }),
    sendTemplate: (to, template, params) =>
      send({
        to: to.replace("+", ""),
        type: "template",
        template: {
          name: template,
          language: { code: "en" },
          ...(params.length
            ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }
            : {}),
        },
      }),
    async templateApproved(name) {
      const { data } = await api<{ data: { name: string; status: string }[] }>(
        `/${config.businessAccountId}/message_templates?name=${encodeURIComponent(name)}`,
      );
      return data.some((t) => t.name === name && t.status === "APPROVED");
    },
  };
}
