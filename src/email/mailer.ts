/**
 * Email delivery.
 *
 * The transport is an interface so the login flow never depends on a provider,
 * and so tests can capture messages instead of sending them.
 */

export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly name: string;
  send(message: Message): Promise<void>;
}

/** Development default: prints instead of sending, so no key is required. */
export class ConsoleMailer implements Mailer {
  readonly name = "console";
  readonly sent: Message[] = [];

  async send(message: Message): Promise<void> {
    this.sent.push(message);
    console.log(
      `\n--- email (not sent) ---\nto: ${message.to}\nsubject: ${message.subject}\n\n${message.text}\n------------------------\n`,
    );
  }
}

/** Test double: captures without printing. */
export class CapturingMailer implements Mailer {
  readonly name = "capturing";
  readonly sent: Message[] = [];

  async send(message: Message): Promise<void> {
    this.sent.push(message);
  }

  last(): Message | undefined {
    return this.sent[this.sent.length - 1];
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Resend over plain fetch — no SDK dependency for one endpoint.
 *
 * Throws on failure so the caller decides. For login codes that means the user
 * sees an error and can retry, rather than waiting for a mail that never comes.
 */
export class ResendMailer implements Mailer {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: Message): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Resend rejected the message (${response.status}): ${detail.slice(0, 300)}`);
    }
  }
}

let cached: Mailer | undefined;

/**
 * Resend when RESEND_API_KEY is present, console otherwise. Deliberately not a
 * hard failure without a key: local development should not need one.
 */
export function mailer(): Mailer {
  if (cached) return cached;

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  if (apiKey && from) {
    cached = new ResendMailer(apiKey, from);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "RESEND_API_KEY and MAIL_FROM are required in production; refusing to " +
          "fall back to the console mailer, which would silently drop login codes.",
      );
    }
    cached = new ConsoleMailer();
  }
  return cached;
}

/** Tests and scripts override the singleton through this. */
export function setMailer(instance: Mailer | undefined): void {
  cached = instance;
}
