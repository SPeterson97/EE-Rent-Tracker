import { createHash, randomBytes } from "node:crypto";
import type { OrgRole } from "@prisma/client";
import { ownerDb } from "../db.js";
import { normalizeEmail } from "./codes.js";
import { createSession, type IssuedSession, type SessionContext } from "./sessions.js";

/**
 * Account creation.
 *
 * The role separation the product requires is enforced structurally rather
 * than by a checkbox: landlords self-register, tenants exist only by
 * invitation. There is no "sign up as a tenant" path at all, so a role is a
 * consequence of how the account came into being.
 *
 * app_user itself carries no role. Roles live in org_member (landlord side)
 * and lease_tenant (tenant side), so one identity could later hold both
 * without a migration — the restriction here is product policy, not schema.
 */

const INVITE_TTL_DAYS = 7;

/** Invitation tokens are 256-bit random values; SHA-256 alone is sufficient. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type RegisterLandlordResult =
  | { ok: true; userId: string; orgId: string; session: IssuedSession }
  | { ok: false; reason: "email_taken" };

/**
 * Self-serve landlord signup: creates the user, their org, and an owner
 * membership atomically. A half-created landlord with no org would be able to
 * log in and see nothing, with no route to recover.
 */
export async function registerLandlord(input: {
  email: string;
  orgName: string;
  displayName?: string | null;
  ctx?: SessionContext;
}): Promise<RegisterLandlordResult> {
  const email = normalizeEmail(input.email);

  const existing = await ownerDb().appUser.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { ok: false, reason: "email_taken" };

  const { userId, orgId } = await ownerDb().$transaction(async (tx) => {
    const user = await tx.appUser.create({
      data: { email, displayName: input.displayName ?? null },
    });
    const org = await tx.org.create({ data: { name: input.orgName } });
    await tx.orgMember.create({ data: { orgId: org.id, userId: user.id, role: "owner" } });
    return { userId: user.id, orgId: org.id };
  });

  const session = await createSession(userId, input.ctx ?? {});
  return { ok: true, userId, orgId, session };
}

export type CreateInvitationResult =
  | { ok: true; invitationId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "not_authorized" | "already_member" | "invalid_target" };

/**
 * Invites someone to an org (as staff) or to a lease (as a tenant).
 *
 * The inviter must belong to the org that owns the target. Tenants hold no
 * org_member row, so this check is also what prevents a tenant from inviting
 * anyone — the role separation falls out rather than being special-cased.
 *
 * The returned token is shown once and never stored in plaintext; email it.
 */
export async function createInvitation(input: {
  inviterUserId: string;
  email: string;
  orgId?: string;
  leaseId?: string;
  orgRole?: OrgRole;
}): Promise<CreateInvitationResult> {
  const email = normalizeEmail(input.email);

  // A CHECK constraint enforces this too; failing early gives a better error.
  const targets = [input.orgId, input.leaseId].filter(Boolean).length;
  if (targets !== 1) return { ok: false, reason: "invalid_target" };
  if (input.orgId && !input.orgRole) return { ok: false, reason: "invalid_target" };

  // Resolve which org governs the target, then confirm the inviter is in it.
  let governingOrgId: string | null = null;

  if (input.orgId) {
    governingOrgId = input.orgId;
  } else {
    const lease = await ownerDb().lease.findUnique({
      where: { id: input.leaseId },
      select: { unit: { select: { property: { select: { orgId: true } } } } },
    });
    governingOrgId = lease?.unit.property.orgId ?? null;
  }
  if (!governingOrgId) return { ok: false, reason: "invalid_target" };

  const membership = await ownerDb().orgMember.findUnique({
    where: { orgId_userId: { orgId: governingOrgId, userId: input.inviterUserId } },
    select: { role: true },
  });
  if (!membership) return { ok: false, reason: "not_authorized" };

  // Only owners may add staff; staff can still invite tenants to leases.
  if (input.orgId && membership.role !== "owner") return { ok: false, reason: "not_authorized" };

  const invitee = await ownerDb().appUser.findUnique({ where: { email }, select: { id: true } });
  if (invitee) {
    const alreadyIn = input.orgId
      ? await ownerDb().orgMember.findUnique({
          where: { orgId_userId: { orgId: input.orgId, userId: invitee.id } },
        })
      : await ownerDb().leaseTenant.findUnique({
          where: { leaseId_userId: { leaseId: input.leaseId!, userId: invitee.id } },
        });
    if (alreadyIn) return { ok: false, reason: "already_member" };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const invitation = await ownerDb().invitation.create({
    data: {
      email,
      tokenHash: hashToken(token),
      invitedBy: input.inviterUserId,
      orgId: input.orgId ?? null,
      leaseId: input.leaseId ?? null,
      orgRole: input.orgRole ?? null,
      expiresAt,
    },
    select: { id: true },
  });

  return { ok: true, invitationId: invitation.id, token, expiresAt };
}

export type AcceptInvitationResult =
  | { ok: true; userId: string; session: IssuedSession; role: "landlord_staff" | "tenant" }
  | { ok: false; reason: "invalid_or_expired" };

/**
 * Redeems an invitation token, creating the account if this is the invitee's
 * first one. This is the only code path that can produce a tenant.
 *
 * The whole redemption is one transaction: an account created without its
 * membership would be a user who can log in but belongs to nothing.
 */
export async function acceptInvitation(input: {
  token: string;
  displayName?: string | null;
  ctx?: SessionContext;
}): Promise<AcceptInvitationResult> {
  const invitation = await ownerDb().invitation.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });

  if (
    !invitation ||
    invitation.acceptedAt !== null ||
    invitation.revokedAt !== null ||
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const result = await ownerDb().$transaction(async (tx) => {
    const user =
      (await tx.appUser.findUnique({ where: { email: invitation.email } })) ??
      (await tx.appUser.create({
        data: { email: invitation.email, displayName: input.displayName ?? null },
      }));

    let role: "landlord_staff" | "tenant";

    if (invitation.orgId) {
      await tx.orgMember.create({
        data: { orgId: invitation.orgId, userId: user.id, role: invitation.orgRole ?? "staff" },
      });
      role = "landlord_staff";
    } else {
      await tx.leaseTenant.create({
        data: { leaseId: invitation.leaseId!, userId: user.id },
      });
      role = "tenant";
    }

    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date(), acceptedUserId: user.id },
    });

    return { userId: user.id, role };
  });

  const session = await createSession(result.userId, input.ctx ?? {});
  return { ok: true, userId: result.userId, session, role: result.role };
}

/**
 * Withdraws an unaccepted invitation. The actor must belong to the org that
 * governs it — without that check any authenticated user could cancel another
 * landlord's invitations by guessing an id.
 */
export async function revokeInvitation(input: {
  invitationId: string;
  actorUserId: string;
}): Promise<boolean> {
  const invitation = await ownerDb().invitation.findUnique({
    where: { id: input.invitationId },
    select: {
      orgId: true,
      lease: { select: { unit: { select: { property: { select: { orgId: true } } } } } },
    },
  });
  if (!invitation) return false;

  const governingOrgId = invitation.orgId ?? invitation.lease?.unit.property.orgId ?? null;
  if (!governingOrgId) return false;

  const membership = await ownerDb().orgMember.findUnique({
    where: { orgId_userId: { orgId: governingOrgId, userId: input.actorUserId } },
    select: { role: true },
  });
  if (!membership) return false;

  const { count } = await ownerDb().invitation.updateMany({
    where: { id: input.invitationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}

export const invitationPolicy = { INVITE_TTL_DAYS } as const;
