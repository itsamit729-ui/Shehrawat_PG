import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().startsWith("mysql://"),
  DB_TLS: z.enum(["required", "off"]).default("required"),
  DB_CA_CERT: z.string().default(""),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(5),
  AUTH_SECRET: z.string().min(32),
  FRONTEND_ORIGINS: z.string().min(1),
  FRONTEND_URL: z.url(),
  COOKIE_DOMAIN: z.string().default(""),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  BUSINESS_SLUG: z.string().min(1).default("sehrawat"),
  // "log" prints codes and links to the service logs: a stopgap until real providers exist.
  SMS_PROVIDER: z.enum(["dev", "log"]).default("dev"),
  MAIL_PROVIDER: z.enum(["dev", "log"]).default("dev"),
  JOB_RUNNER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Name the settings but never print their values: some are secrets.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment settings: ${names}`);
  }
  const c = parsed.data;
  const production = c.NODE_ENV === "production";
  if (production) {
    if (c.DB_TLS !== "required") throw new Error("Production requires DB_TLS=required.");
    if (!c.DB_CA_CERT) throw new Error("Production requires DB_CA_CERT to verify the database.");
    if (c.SMS_PROVIDER === "dev" || c.MAIL_PROVIDER === "dev")
      throw new Error("The dev SMS and mail providers print secrets and cannot run in production.");
    if (!c.FRONTEND_URL.startsWith("https://")) throw new Error("Production requires an HTTPS FRONTEND_URL.");
  }
  const frontendOrigins = c.FRONTEND_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (frontendOrigins.some((o) => o.includes("*")))
    throw new Error("FRONTEND_ORIGINS must list exact origins.");
  return {
    production,
    env: c.NODE_ENV,
    port: c.PORT,
    db: {
      url: c.DATABASE_URL,
      tls: c.DB_TLS === "required",
      caCert: c.DB_CA_CERT.replaceAll("\\n", "\n"),
      poolSize: c.DB_POOL_SIZE,
    },
    authSecret: c.AUTH_SECRET,
    frontendOrigins,
    frontendUrl: c.FRONTEND_URL.replace(/\/$/, ""),
    cookie: {
      domain: c.COOKIE_DOMAIN || undefined,
      sameSite: c.COOKIE_SAMESITE,
      secure: production || c.COOKIE_SAMESITE === "none",
    },
    logsAuthSecrets: c.SMS_PROVIDER === "log" || c.MAIL_PROVIDER === "log",
    trustProxyHops: c.TRUST_PROXY_HOPS,
    businessSlug: c.BUSINESS_SLUG,
    jobRunnerEnabled: c.JOB_RUNNER_ENABLED,
  };
}
