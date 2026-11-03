import {createHash} from "node:crypto";
import {Auth} from "firebase-admin/auth";
import {Database} from "firebase-admin/database";
import {HttpsError} from "firebase-functions/v2/https";
import {transactionWithRetry} from "../be1/databaseTransaction";

export const userLockKey = (uid: string) =>
  createHash("sha256").update(`user/${uid}`).digest("hex");

/** Permanent operation ownership, shared by status APIs and the server role CLI. */
export async function acquireMembership(db: Database, operationId: string): Promise<void> {
  const tx = await transactionWithRetry(db.ref("adminMembership/lock"), (current) => {
    if (current && current.operationId !== operationId) return;
    return {operationId};
  });
  if (!tx.committed) {
    throw new HttpsError("aborted", "Another account access change is pending.", {reason: "membership-busy"});
  }
}

export async function releaseMembership(db: Database, operationId: string): Promise<void> {
  await transactionWithRetry(db.ref("adminMembership/lock"), (current) =>
    !current || current.operationId === operationId ? null : undefined);
}

/** Call only while holding the membership lock; Auth remains authoritative. */
export async function protectLastAdmin(auth: Auth, db: Database, targetUid: string): Promise<void> {
  const target = await auth.getUser(targetUid);
  const access = (await db.ref(`accountAccess/${targetUid}/status`).get()).val();
  if (target.disabled || target.customClaims?.admin !== true || access !== "active") return;
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.uid === targetUid || user.disabled || user.customClaims?.admin !== true) continue;
      const other = (await db.ref(`accountAccess/${user.uid}/status`).get()).val();
      if (other === "active") return;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  throw new HttpsError("failed-precondition", "The last active administrator must be retained.", {
    reason: "last-active-admin",
  });
}
