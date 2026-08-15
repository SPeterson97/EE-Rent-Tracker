import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reads the jurisdiction reference data in content/jurisdictions.
 *
 * Rules live as data rather than code so a statutory change is a file edit, and
 * so the same fact can render as an inline hint, a reference panel, or a
 * validation constraint. See content/jurisdictions/README of MIGRATIONS.md.
 */

export interface JurisdictionRule {
  id: string;
  applies_to: string;
  enforcement: "hard_limit" | "advisory" | "deadline";
  verification_status: "confident" | "verify_with_counsel";
  constraint?: Record<string, unknown>;
  recommended_default?: Record<string, unknown>;
  ui: { inline_hint: string; reference: string };
  citation: string;
}

export interface Jurisdiction {
  id: string;
  level: "state" | "city";
  name: string;
  parent: string | null;
  effective_as_of: string;
  disclaimer: string;
  rules: JurisdictionRule[];
}

const CONTENT_DIR = join(process.cwd(), "content", "jurisdictions");
const cache = new Map<string, Jurisdiction | null>();

export async function loadJurisdiction(id: string): Promise<Jurisdiction | null> {
  if (cache.has(id)) return cache.get(id)!;
  try {
    const raw = await readFile(join(CONTENT_DIR, `${id}.json`), "utf8");
    const parsed = JSON.parse(raw) as Jurisdiction;
    cache.set(id, parsed);
    return parsed;
  } catch {
    cache.set(id, null);
    return null;
  }
}

/**
 * Resolves a jurisdiction and its ancestors, most specific first.
 *
 * A Pittsburgh property inherits Pennsylvania; a rule defined at both levels is
 * won by the city.
 */
export async function resolveRules(id: string): Promise<JurisdictionRule[]> {
  const chain: Jurisdiction[] = [];
  let current: string | null = id;

  while (current) {
    const jurisdiction: Jurisdiction | null = await loadJurisdiction(current);
    if (!jurisdiction) break;
    chain.push(jurisdiction);
    current = jurisdiction.parent;
  }

  const byId = new Map<string, JurisdictionRule>();
  // Walk least-specific first so the city overwrites the state.
  for (const jurisdiction of chain.reverse()) {
    for (const rule of jurisdiction.rules) byId.set(rule.applies_to + ":" + rule.id, rule);
  }
  return [...byId.values()];
}

/** Statutory deposit-return window. Falls back to the PA default of 30 days. */
export async function returnDeadlineDays(jurisdictionId: string): Promise<number> {
  const rules = await resolveRules(jurisdictionId);
  const rule = rules.find((r) => r.enforcement === "deadline" && r.applies_to === "lease.move_out");
  const days = rule?.constraint?.deadline_days;
  return typeof days === "number" ? days : 30;
}

/** Deposit caps, for validating a lease before it is saved. */
export async function depositCapMonths(
  jurisdictionId: string,
  tenancyYear: number,
): Promise<number | null> {
  const rules = await resolveRules(jurisdictionId);
  const rule = rules.find((r) => r.applies_to === "lease.security_deposit_cents");
  if (!rule?.constraint) return null;

  const firstYear = rule.constraint.max_months_rent_first_year;
  const later = rule.constraint.max_months_rent_after_first_year;
  const value = tenancyYear <= 1 ? firstYear : later;
  return typeof value === "number" ? value : null;
}

/** Everything the UI should surface for a given screen. */
export async function rulesFor(jurisdictionId: string, appliesTo: string) {
  const rules = await resolveRules(jurisdictionId);
  return rules.filter((r) => r.applies_to === appliesTo);
}
