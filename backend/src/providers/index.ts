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

/** Local development only: config refuses to start production with these. */
export function createProviders(_config: Config): Providers {
  return {
    sms: {
      async sendOtp(phone, code) {
        console.info(`[dev sms] ${phone}: your Sehrawat PG code is ${code}`);
      },
    },
    mail: {
      async sendPasswordLink({ to, purpose, url }) {
        console.info(`[dev mail] ${to} (${purpose}): ${url}`);
      },
    },
  };
}
