import { randomUUID } from "node:crypto";
import type { ConnectedAccount, PaymentIntentResult, StripeGateway } from "./gateway.js";

/**
 * In-memory Stripe stand-in, so the payment logic can be tested without API
 * keys or network access.
 *
 * Models the behaviour that actually matters: idempotency keys returning the
 * original intent, and ACH landing in `processing` rather than `succeeded` —
 * the assumption that a payment is done when the API call returns is exactly
 * the bug this suite needs to be able to catch.
 */
export class FakeStripeGateway implements StripeGateway {
  readonly accounts = new Map<string, ConnectedAccount>();
  readonly customers = new Map<string, { email: string; userId: string }>();
  readonly intents = new Map<string, PaymentIntentResult & { idempotencyKey: string }>();
  readonly onboardingLinks: { accountId: string; url: string }[] = [];

  /** Flip to simulate a landlord who has not finished onboarding. */
  payoutsEnabled = true;

  async createConnectedAccount(input: { email: string; orgName: string }): Promise<ConnectedAccount> {
    const account: ConnectedAccount = {
      id: `acct_${randomUUID().slice(0, 12)}`,
      // A brand new Express account can do nothing until onboarding completes.
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const url = `https://connect.stripe.test/setup/${input.accountId}`;
    this.onboardingLinks.push({ accountId: input.accountId, url });
    return { url, expiresAt: new Date(Date.now() + 5 * 60 * 1000) };
  }

  async retrieveAccount(accountId: string): Promise<ConnectedAccount> {
    const existing = this.accounts.get(accountId);
    if (!existing) throw new Error(`no such account ${accountId}`);
    return { ...existing, chargesEnabled: this.payoutsEnabled, payoutsEnabled: this.payoutsEnabled };
  }

  /** Test helper: pretend the landlord finished Stripe's onboarding flow. */
  completeOnboarding(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      });
    }
  }

  async createCustomer(input: { email: string; userId: string }): Promise<{ id: string }> {
    const id = `cus_${randomUUID().slice(0, 12)}`;
    this.customers.set(id, input);
    return { id };
  }

  async createBankSetupIntent(input: { customerId: string }) {
    const id = `seti_${randomUUID().slice(0, 12)}`;
    return { id, clientSecret: `${id}_secret_test` };
  }

  async createPaymentIntent(input: {
    amountCents: bigint;
    customerId: string;
    paymentMethodId: string;
    destinationAccountId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    // Stripe returns the ORIGINAL intent for a repeated idempotency key rather
    // than creating a second one. Without this the fake would let a bug through.
    for (const intent of this.intents.values()) {
      if (intent.idempotencyKey === input.idempotencyKey) {
        return { id: intent.id, status: intent.status, clientSecret: intent.clientSecret };
      }
    }

    const id = `pi_${randomUUID().slice(0, 12)}`;
    // ACH is never immediately successful — days, not milliseconds.
    const result: PaymentIntentResult & { idempotencyKey: string } = {
      id,
      status: "processing",
      clientSecret: `${id}_secret_test`,
      idempotencyKey: input.idempotencyKey,
    };
    this.intents.set(id, result);
    return { id, status: result.status, clientSecret: result.clientSecret };
  }
}
