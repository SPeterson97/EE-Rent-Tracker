/**
 * Splitting a charge across tenants, and working out what is still owed.
 *
 * All integer cents. Every function is pure and total: given the same inputs it
 * returns the same output, and allocations always sum to exactly the charge —
 * a split that loses or invents a cent is a reconciliation bug that surfaces
 * months later as an unexplainable balance.
 */

export interface Weight {
  id: string;
  /**
   * Relative weight. Usually basis points from a split plan, optionally
   * multiplied by occupied days for a period a tenant only partly occupied.
   */
  weight: number;
  absorbsRemainder?: boolean;
}

export interface Allocation {
  id: string;
  amountCents: bigint;
}

/**
 * Distributes `amountCents` across `weights`.
 *
 * Floor each share, then hand every leftover cent to the designated absorber.
 * Rounding each share independently would drift away from the total; flooring
 * plus a single explicit absorber is deterministic and always reconciles.
 *
 * Rent of $2000 split three ways is the canonical case: 66666 + 66666 + 66666
 * is 199998, and the absorber takes the remaining 2 cents.
 */
export function allocate(amountCents: bigint, weights: Weight[]): Allocation[] {
  const positive = weights.filter((w) => w.weight > 0);
  if (positive.length === 0) return [];

  const totalWeight = positive.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight <= 0) return [];

  // Scale to integers so the division is exact rather than float-rounded.
  const scale = 1_000_000;
  const scaledTotal = BigInt(Math.round(totalWeight * scale));

  const allocations: Allocation[] = positive.map((w) => ({
    id: w.id,
    amountCents: (amountCents * BigInt(Math.round(w.weight * scale))) / scaledTotal,
  }));

  const distributed = allocations.reduce((sum, a) => sum + a.amountCents, 0n);
  let remainder = amountCents - distributed;

  if (remainder !== 0n) {
    const absorberId =
      positive.find((w) => w.absorbsRemainder)?.id ??
      // No designated absorber: give it to the largest share, deterministically
      // tie-broken by id so the result never depends on input ordering.
      [...positive].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))[0]!.id;

    const absorber = allocations.find((a) => a.id === absorberId)!;
    absorber.amountCents += remainder;
    remainder = 0n;
  }

  return allocations;
}

export type ChargeKind = "rent" | "water" | "late_fee" | "deposit" | "other";

export interface OutstandingInput {
  id: string;
  kind: ChargeKind;
  amountCents: bigint;
  dueOn: Date;
}

export interface Outstanding {
  id: string;
  kind: ChargeKind;
  amountCents: bigint;
  dueOn: Date;
  paidCents: bigint;
  outstandingCents: bigint;
}

/**
 * Priority within a due date. Rent first, fees last.
 *
 * Applying payments to fees first is legally hazardous: it converts a tenant
 * who paid their rent into a rent delinquent on paper, which can manufacture
 * grounds for eviction. Courts take a dim view, and some jurisdictions
 * prohibit it outright.
 */
const KIND_PRIORITY: Record<ChargeKind, number> = {
  rent: 0,
  water: 1,
  deposit: 2,
  other: 3,
  late_fee: 4,
};

/**
 * Applies a pool of credits across charges oldest-first, fees last, and
 * reports what remains on each.
 *
 * The ledger is deliberately lease-level and joint-and-several, so payments are
 * not tied to specific charges. This is the rule that answers "is September
 * rent actually paid?" without inventing per-charge debts.
 */
export function applyCredits(
  charges: OutstandingInput[],
  creditCents: bigint,
): Outstanding[] {
  const ordered = [...charges].sort(
    (a, b) =>
      a.dueOn.getTime() - b.dueOn.getTime() ||
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      a.id.localeCompare(b.id),
  );

  let pool = creditCents > 0n ? creditCents : 0n;

  return ordered.map((charge) => {
    const applied = pool >= charge.amountCents ? charge.amountCents : pool;
    pool -= applied;
    return {
      ...charge,
      paidCents: applied,
      outstandingCents: charge.amountCents - applied,
    };
  });
}

export interface LateFeeConfig {
  kind: "flat" | "percent_of_rent";
  /** Cents when flat, whole percent when percent_of_rent. */
  value: bigint;
  capCents: bigint | null;
}

/**
 * The fee for an overdue balance. Returns 0n when nothing is owed, so callers
 * never post a zero-amount charge (the schema rejects those anyway).
 */
export function lateFeeAmount(config: LateFeeConfig, overdueCents: bigint): bigint {
  if (overdueCents <= 0n) return 0n;

  const raw =
    config.kind === "flat"
      ? config.value
      : // Percent of the overdue amount, floored to whole cents.
        (overdueCents * config.value) / 100n;

  if (raw <= 0n) return 0n;
  if (config.capCents !== null && raw > config.capCents) return config.capCents;
  return raw;
}
