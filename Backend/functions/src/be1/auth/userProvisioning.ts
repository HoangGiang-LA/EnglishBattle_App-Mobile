import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../../config/firebaseAdmin";
import {transactionWithRetry} from "../databaseTransaction";
import {syncLeaderboardPlayer} from "../community/leaderboardProjection";

/** Initialize defaults once; never replace balances, progress or access. */
export const createUserDefault = async (path: string, initial: object): Promise<void> => {
  await transactionWithRetry(adminDb.ref(path), (current) => current || initial);
};

/** Server-only provisioning for a trusted target UID, never taken from callable data. */
export async function provisionUserProfile(uid: string, allowProvisioning = false): Promise<void> {
  const user = await adminAuth.getUser(uid);
  const accessRef = adminDb.ref(`accountAccess/${uid}`);
  const [access, tombstone] = await Promise.all([
    accessRef.get(), adminDb.ref(`adminUserState/${uid}/deleted`).get(),
  ]);
  const allowed = (status: unknown) => status === "active" || (allowProvisioning && status === "provisioning");
  if (user.disabled || tombstone.val() === true || (access.exists() && !allowed(access.val().status))) {
    throw new HttpsError("permission-denied", "This account is not active.");
  }
  const now = Date.now();
  const createdAt = Date.parse(user.metadata.creationTime) || now;
  await createUserDefault(`accountAccess/${uid}`, {status: "active", createdAt, updatedAt: now});
  if (!allowed((await accessRef.get()).val()?.status)) {
    throw new HttpsError("permission-denied", "This account is not active.");
  }
  await createUserDefault(`users/${uid}`, {
    displayCode: `EB-${uid}`, displayName: user.displayName || "New Player",
    avatarPath: "", createdAt, provisionedAt: now, updatedAt: now, revision: 0,
  });
  await createUserDefault(`userPrivate/${uid}`, {email: user.email || "", createdAt, updatedAt: now, revision: 0});
  await createUserDefault(`userStats/${uid}`, {
    rating: 0, matchesPlayed: 0, wins: 0, losses: 0, draws: 0, winStreak: 0, updatedAt: now,
  });
  await createUserDefault(`wallets/${uid}`, {coinBalance: 0, updatedAt: now});
  await createUserDefault(`userSettings/${uid}`, {
    notificationsEnabled: false, soundVolume: 1, language: "vi", theme: "system", updatedAt: now,
  });
  await syncUserIdentity(uid);
  if (!allowed((await accessRef.get()).val()?.status) || (await adminAuth.getUser(uid)).disabled) {
    throw new HttpsError("permission-denied", "This account is not active.");
  }
  await syncLeaderboardPlayer(uid);
}

/** Revision fencing prevents an old provisioning read overwriting an admin edit. */
export async function syncUserIdentity(uid: string): Promise<void> {
  const stateRef = adminDb.ref(`adminUserState/${uid}`);
  const before = (await stateRef.get()).val();
  if (before?.pendingOperation || before?.deleted) return;
  const [user, profile, access] = await Promise.all([
    adminAuth.getUser(uid), adminDb.ref(`users/${uid}`).get(), adminDb.ref(`accountAccess/${uid}`).get(),
  ]);
  if (user.disabled || !["active", "provisioning"].includes(access.val()?.status)) return;
  const name = (user.displayName || "New Player").slice(0, 100);
  const email = user.email || "";
  const tx = await transactionWithRetry(stateRef, (current) => {
    if (current?.pendingOperation || current?.deleted) return current;
    if (Number(current?.revision || 0) !== Number(before?.revision || 0)) return current;
    if (current && current.name === name && current.email === email) return current;
    return {...current, name, email,
      revision: current ? Number(current.revision || 0) + 1 : Number(profile.val()?.revision || 0),
      updatedAt: Date.now()};
  });
  const state = tx.snapshot.val();
  if (!state || state.pendingOperation || state.deleted) return;
  for (const [path, values] of [
    [`users/${uid}`, {displayName: state.name}],
    [`userPrivate/${uid}`, {email: state.email}],
  ] as const) {
    await transactionWithRetry(adminDb.ref(path), (current) => {
      if (!current) return current;
      if (Number(current.revision || 0) > Number(state.revision || 0)) return;
      if (Object.entries(values).every(([key, value]) => current[key] === value) &&
          Number(current.revision || 0) === Number(state.revision || 0)) return current;
      return {...current, ...values, revision: state.revision, updatedAt: state.updatedAt};
    });
  }
}
