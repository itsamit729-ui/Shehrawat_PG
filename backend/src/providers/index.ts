import type { Config } from "../config.js";

/** Providers are adapters, so a vendor can change without touching identity code. */
export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

export interface MailProvider {
  sendPasswordLink(input: { to: string; name: string; purpose: "invite" | "recovery"; url: string }): Promise<void>;
}

export interface Providers {
  sms: SmsProvider;
  mail: MailProvider;
}

/**
 * Prints instead of sending, for both "dev" (local only) and "log" (the stopgap allowed in
 * production). Anyone who can read the logs can use these codes and links to sign in.
 */
export function createProviders(_config: Config): Providers {
  return {
    sms: {
      async sendOtp(phone, code) {
        console.info(`[sms not sent] ${phone}: your Sehrawat PG code is ${code}`);
      },
    },
    mail: {
      async sendPasswordLink({ to, purpose, url }) {
        console.info(`[email not sent] ${to} (${purpose}): ${url}`);
      },
    },
  };
}
