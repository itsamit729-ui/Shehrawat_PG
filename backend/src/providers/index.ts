import type { Config } from "../config.js";

/** Providers are adapters, so a vendor can change without touching identity code. */
export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

export type MailPurpose = "invite" | "recovery" | "verify";

export interface MailProvider {
  sendPasswordLink(input: { to: string; name: string; purpose: MailPurpose; url: string }): Promise<void>;
}

export interface GoogleProfile {
  sub?: string;
  email?: string;
  emailVerified: boolean;
}

export interface GoogleProvider {
  exchangeCode(code: string): Promise<GoogleProfile>;
}

export interface Providers {
  sms: SmsProvider;
  mail: MailProvider;
  google: GoogleProvider;
}

const MAIL_SUBJECT: Record<MailPurpose, string> = {
  invite: "Set up your Sehrawat PG account",
  recovery: "Reset your Sehrawat PG password",
  verify: "Verify your Sehrawat PG email",
};
const MAIL_TIMEOUT_MS = 10_000;

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The error names only the HTTP status: responses can echo the recipient or link. */
async function postMail(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error("Mail provider rejected the message"), { code: String(response.status) });
}

function createMail(config: Config): MailProvider {
  const { provider, apiKey, from } = config.mail;
  if (provider === "dev" || provider === "log")
    return {
      async sendPasswordLink({ to, purpose, url }) {
        console.info(`[email not sent] ${to} (${purpose}): ${url}`);
      },
    };
  return {
    async sendPasswordLink({ to, purpose, url }) {
      const subject = MAIL_SUBJECT[purpose];
      const html = `<h1>${subject}</h1><p><a href="${escapeHtml(url)}">Continue to Sehrawat PG</a></p><p>This link works once and expires. If you did not request it, ignore this email.</p>`;
      if (provider === "brevo")
        await postMail(
          "https://api.brevo.com/v3/smtp/email",
          { "api-key": apiKey },
          { sender: { email: from, name: "Sehrawat PG" }, to: [{ email: to }], subject, htmlContent: html },
        );
      else
        await postMail(
          "https://api.resend.com/emails",
          { Authorization: `Bearer ${apiKey}` },
          { from, to: [to], subject, html },
        );
    },
  };
}

function createGoogle(config: Config): GoogleProvider {
  return {
    async exchangeCode(code) {
      if (!config.google) throw new Error("Google sign-in is not configured");
      const tokens = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: config.google.redirectUri,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      if (!tokens.ok) throw new Error("Google rejected the sign-in code");
      const { access_token: accessToken } = (await tokens.json()) as { access_token: string };
      // The code was exchanged by this confidential client over TLS, so Google's answer is direct.
      const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      if (!info.ok) throw new Error("Google did not return a profile");
      const profile = (await info.json()) as { sub?: string; email?: string; email_verified?: boolean };
      return { sub: profile.sub, email: profile.email, emailVerified: profile.email_verified === true };
    },
  };
}

/**
 * "dev" (local only) and "log" (the stopgap allowed in production) print instead of sending.
 * Anyone who can read the logs can use those codes and links to sign in.
 */
export function createProviders(config: Config): Providers {
  return {
    sms: {
      async sendOtp(phone, code) {
        console.info(`[sms not sent] ${phone}: your Sehrawat PG code is ${code}`);
      },
    },
    mail: createMail(config),
    google: createGoogle(config),
  };
}
