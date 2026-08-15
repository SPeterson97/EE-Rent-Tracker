import Stripe from "stripe";

/**
 * A narrow port over the parts of Stripe this application uses.
 *
 * Defined as an interface rather than passing the SDK around so the payment
 * logic can be tested without API keys or network access. The real adapter is
 * a thin wrapper; the fake used by the suite lives in gateway.fake.ts.
 */

export interface ConnectedAccount {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface PaymentIntentResult {
  id: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "succeeded"
    | "canceled";
  clientSecret: string | null;
}

export interface StripeGateway {
  createConnectedAccount(input: { email: string; orgName: string }): Promise<ConnectedAccount>;
  createOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  retrieveAccount(accountId: string): Promise<ConnectedAccount>;

  createCustomer(input: { email: string; userId: string }): Promise<{ id: string }>;
  /** Collects and verifies a bank account without charging it. */
  createBankSetupIntent(input: {
    customerId: string;
  }): Promise<{ id: string; clientSecret: string | null }>;

  createPaymentIntent(input: {
    amountCents: bigint;
    customerId: string;
    paymentMethodId: string;
    /** Landlord's connected account — this is where the money lands. */
    destinationAccountId: string;
    /** Guards against double-charging on retry. */
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<PaymentIntentResult>;
}

/** Real Stripe. Requires STRIPE_SECRET_KEY. */
export class LiveStripeGateway implements StripeGateway {
  constructor(private readonly stripe: Stripe) {}

  async createConnectedAccount(input: { email: string; orgName: string }): Promise<ConnectedAccount> {
    // Express: Stripe hosts the KYC and identity flow, so this application
    // never collects or stores government identifiers or bank credentials.
    const account = await this.stripe.accounts.create({
      type: "express",
      email: input.email,
      business_profile: { name: input.orgName },
      capabilities: {
        transfers: { requested: true },
        us_bank_account_ach_payments: { requested: true },
      },
    });
    return toConnectedAccount(account);
  }

  async createOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    const link = await this.stripe.accountLinks.create({
      account: input.accountId,
      refresh_url: input.refreshUrl,
      return_url: input.returnUrl,
      type: "account_onboarding",
    });
    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  async retrieveAccount(accountId: string): Promise<ConnectedAccount> {
    return toConnectedAccount(await this.stripe.accounts.retrieve(accountId));
  }

  async createCustomer(input: { email: string; userId: string }): Promise<{ id: string }> {
    const customer = await this.stripe.customers.create({
      email: input.email,
      metadata: { appUserId: input.userId },
    });
    return { id: customer.id };
  }

  async createBankSetupIntent(input: { customerId: string }) {
    const intent = await this.stripe.setupIntents.create({
      customer: input.customerId,
      payment_method_types: ["us_bank_account"],
      // Instant verification via Financial Connections. Microdeposits take days
      // and lose a meaningful share of users to abandonment.
      payment_method_options: {
        us_bank_account: { verification_method: "instant" },
      },
    });
    return { id: intent.id, clientSecret: intent.client_secret };
  }

  async createPaymentIntent(input: {
    amountCents: bigint;
    customerId: string;
    paymentMethodId: string;
    destinationAccountId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: Number(input.amountCents),
        currency: "usd",
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        payment_method_types: ["us_bank_account"],
        confirm: true,
        // Destination charge: funds settle into the landlord's connected
        // account, which keeps Stripe as the money transmitter rather than us.
        transfer_data: { destination: input.destinationAccountId },
        on_behalf_of: input.destinationAccountId,
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );

    return {
      id: intent.id,
      status: intent.status as PaymentIntentResult["status"],
      clientSecret: intent.client_secret,
    };
  }
}

function toConnectedAccount(account: Stripe.Account): ConnectedAccount {
  return {
    id: account.id,
    chargesEnabled: account.charges_enabled ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
  };
}

let cachedStripe: Stripe | undefined;
let cachedGateway: StripeGateway | undefined;

export function stripeClient(): Stripe {
  if (cachedStripe) return cachedStripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  cachedStripe = new Stripe(key);
  return cachedStripe;
}

export function gateway(): StripeGateway {
  return (cachedGateway ??= new LiveStripeGateway(stripeClient()));
}

/** Tests inject a fake through this. */
export function setGateway(instance: StripeGateway | undefined): void {
  cachedGateway = instance;
}
