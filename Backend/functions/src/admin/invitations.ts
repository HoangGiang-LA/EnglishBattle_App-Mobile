import {randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {syncAdminUserIndex} from "./userIndex";
import {ADMIN_POLICY} from "./policy";

export async function queueInvitation(uid: string, email: string, operationId: string): Promise<void> {
  await transactionWithRetry(adminDb.ref(`adminInvitations/${uid}`), (current) => {
    if (current?.operationId === operationId) return current;
    if (current?.status === "sending" || current?.status === "pending") return current;
    return {uid, email, operationId, status: "pending", createdAt: Date.now(), dueAt: Date.now()};
  });
}

export async function checkInvitationResend(uid: string): Promise<void> {
  const invitation = (await adminDb.ref(`adminInvitations/${uid}`).get()).val();
  if (["pending", "sending"].includes(invitation?.status) ||
      (invitation && invitation.status !== "failed" && invitation.createdAt > Date.now() - 300000)) {
    throw new HttpsError("failed-precondition", "An invitation is pending or was recently sent.", {reason: "invitation-busy"});
  }
}

/** Built-in Firebase reset email; API keys are public app configuration, not credentials. */
export async function sendInvitationEmail(email: string): Promise<"sent" | "failed" | "unknown"> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (host && !/^127\.0\.0\.1:\d+$/.test(host)) throw new Error("Invitation emulator must use loopback");
  const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  const apiKey = host ? "emulator-only" : process.env.FIREBASE_WEB_API_KEY ||
    (project === "englishbattleapp-8d764" ? "AIzaSyDIihn3E5yD4aq9PJbo8vltY0AFKonJlPQ" : "");
  if (!apiKey) return "failed";
  const base = host ? `http://${host}/identitytoolkit.googleapis.com` : "https://identitytoolkit.googleapis.com";
  try {
    const response = await fetch(`${base}/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: {"Content-Type": "application/json", "X-Firebase-Locale": "vi"},
      body: JSON.stringify({requestType: "PASSWORD_RESET", email}), signal: AbortSignal.timeout(15000),
    });
    await response.arrayBuffer(); // Discard body: never persist/log an OOB code or action link.
    return response.ok ? "sent" : "failed";
  } catch {
    return "unknown";
  }
}

/** A crashed send is ambiguous and never automatically sent a second time. */
export async function runInvitationMaintenance(
  send: typeof sendInvitationEmail = sendInvitationEmail,
): Promise<void> {
  const due = await adminDb.ref("adminInvitations").orderByChild("dueAt")
    .startAt(0).endAt(Date.now()).limitToFirst(10).get();
  const ids: string[] = [];
  due.forEach((child) => {
    ids.push(child.key!);
  });
  for (const uid of ids) {
    const ref = adminDb.ref(`adminInvitations/${uid}`);
    const owner = randomUUID();
    const claim = await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.status === "sending" && c.leaseUntil <= Date.now()) {
        return {...c, status: "unknown", dueAt: null, owner: null, leaseUntil: null,
          completedAt: Date.now(), cleanupAt: Date.now() + ADMIN_POLICY.operationDataMs};
      }
      if (c.status !== "pending" || c.dueAt > Date.now()) return;
      return {...c, status: "sending", owner, leaseUntil: Date.now() + 60000, dueAt: Date.now() + 60000};
    });
    const job = claim.snapshot.val();
    if (!claim.committed || job?.owner !== owner) {
      if (job?.status === "unknown") await syncAdminUserIndex(uid);
      continue;
    }
    let status: "sent" | "failed" | "unknown" = "failed";
    let sending = false;
    try {
      const [user, access] = await Promise.all([
        adminAuth.getUser(uid), adminDb.ref(`accountAccess/${uid}/status`).get(),
      ]);
      if (!user.disabled && user.email === job.email && access.val() === "active") {
        sending = true;
        status = await send(job.email);
      }
    } catch {
      status = sending ? "unknown" : "failed";
    }
    await transactionWithRetry(ref, (c) => {
      if (!c) return c;
      if (c.owner !== owner || c.operationId !== job.operationId || c.status !== "sending") return;
      return {...c, status, completedAt: Date.now(), dueAt: null, owner: null, leaseUntil: null,
        cleanupAt: Date.now() + ADMIN_POLICY.operationDataMs};
    });
    await syncAdminUserIndex(uid);
  }
}
