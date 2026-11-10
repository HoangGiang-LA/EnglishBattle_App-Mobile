import {HttpsError} from "firebase-functions/v2/https";
import {UserRecord as AuthUser} from "firebase-admin/auth";
import {adminAuth} from "../config/firebaseAdmin";
import {AdminProfile, UserRecord, ListQuery} from "./model";
import {
  allow,
  audit,
  choice,
  collection,
  endpoint,
  key,
  mutate,
  read,
  text,
  Obj,
  fingerprint,
} from "./core";
import {idInput, matches, onlyQuery, paginate} from "./validation";

export async function profile(actor: AuthUser): Promise<AdminProfile> {
  const stored = await read(`adminProfiles/${actor.uid}`, false);
  return {
    id: actor.uid,
    name: String(
      stored.displayName || actor.displayName || actor.email || "Administrator"
    ),
    email: actor.email || "",
    role: "administrator",
  };
}
export const adminGetProfile = endpoint(async (input, actor) => {
  allow(input, []);
  return {serverNow: Date.now(), profile: await profile(actor)};
});
export const adminUpdateProfile = endpoint(async (input, actor) => {
  allow(input, ["name", "requestId"]);
  const name = text(input.name, "name", 2, 80);
  return mutate(
    actor,
    "profile.update",
    input,
    [`user_${actor.uid}`],
    async (now, opId) => ({
      auth: {uid: actor.uid, name},
      updates: {
        ...audit(actor, "profile.update", actor.uid, now, opId),
        [`adminProfiles/${actor.uid}/displayName`]: name,
        [`adminProfiles/${actor.uid}/updatedAt`]: now,
        [`users/${actor.uid}/displayName`]: name,
        [`users/${actor.uid}/updatedAt`]: now,
      },
      result: {
        serverNow: now,
        profile: {
          id: actor.uid,
          name,
          email: actor.email || "",
          role: "administrator",
        },
      },
    })
  );
});
export async function user(id: string, source?: Obj): Promise<UserRecord> {
  const u = source || (await read(`users/${id}`, false));
  if (!Object.keys(u).length) {
    throw new HttpsError("not-found", "User not found.");
  }
  const [access, privateData, stats, wallet] = await Promise.all([
    read(`accountAccess/${id}`),
    read(`userPrivate/${id}`),
    read(`userStats/${id}`),
    read(`wallets/${id}`),
  ]);
  const status = choice(
    access.status,
    ["active", "banned", "deleted"] as const,
    "stored status"
  );
  if (
    typeof stats.rating !== "number" ||
    typeof wallet.coinBalance !== "number" ||
    typeof u.createdAt !== "number"
  ) {
    throw new HttpsError(
      "failed-precondition",
      "User projections are incomplete."
    );
  }
  return {
    id,
    code: String(u.displayCode || id),
    name: status === "deleted" ? "Deleted user" : String(u.displayName || ""),
    email: status === "deleted" ? "" : String(privateData.email || ""),
    status,
    createdAt: u.createdAt,
    updatedAt: Number(u.updatedAt || u.createdAt),
    rating: stats.rating,
    coins: wallet.coinBalance,
    ...(typeof access.reason === "string" ? {reason: access.reason} : {}),
  };
}
export async function users(): Promise<UserRecord[]> {
  const rows = await collection("users", 500);
  // Bound concurrency; every source collection is capped before joining private records.
  const out: UserRecord[] = [];
  for (let start = 0; start < rows.length; start += 20) {
    out.push(
      ...(await Promise.all(
        rows.slice(start, start + 20).map(([id, value]) => user(id, value))
      ))
    );
  }
  return out;
}
export function filterUsers(rows: UserRecord[], q: ListQuery): UserRecord[] {
  return rows
    .filter(
      (u) =>
        (q.status ? u.status === q.status : u.status !== "deleted") &&
        matches(`${u.id} ${u.code} ${u.name} ${u.email}`, q.q)
    )
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export const adminListUsers = endpoint(async (input) => ({
  serverNow: Date.now(),
  page: paginate(
    filterUsers(await users(), onlyQuery(input)),
    onlyQuery(input)
  ),
}));
export const adminGetUser = endpoint(async (input) => ({
  serverNow: Date.now(),
  user: await user(idInput(input)),
}));
export const adminSaveUser = endpoint(async (input, actor) => {
  allow(input, ["input", "id", "requestId"]);
  const form = input.input;
  if (form === null || typeof form !== "object" || Array.isArray(form)) {
    throw new HttpsError("invalid-argument", "Invalid input.");
  }
  const f = form as Obj;
  allow(
    f,
    input.id === undefined ? ["name", "email", "password"] : ["name", "email"]
  );
  const name = text(f.name, "name", 2, 80);
  const email = text(f.email, "email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Invalid email.");
  }
  if (input.id === undefined) {
    const password = f.password;
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Initial password needs 12-128 characters, upper/lowercase, a number and a symbol."
      );
    }
    const id =
      "adm_" + fingerprint([actor.uid, key(input.requestId)]).slice(0, 28);
    return mutate(
      actor,
      "user.create",
      input,
      [`user_${id}`],
      async (now, opId) => {
        const roots = [
          "users",
          "userPrivate",
          "accountAccess",
          "userStats",
          "wallets",
          "userSettings",
        ];
        for (const root of roots) {
          if (Object.keys(await read(`${root}/${id}`, false)).length) {
            throw new HttpsError(
              "already-exists",
              "Reserved profile already exists."
            );
          }
        }
        const record: UserRecord = {
          id,
          code: "EB-" + id,
          name,
          email,
          status: "active",
          createdAt: now,
          updatedAt: now,
          rating: 0,
          coins: 0,
        };
        return {
          auth: {uid: id, name, email, create: true},
          result: {serverNow: now, user: record},
          updates: {
            ...audit(actor, "user.create", id, now, opId),
            [`users/${id}`]: {
              displayCode: record.code,
              displayName: name,
              avatarPath: "",
              createdAt: now,
              updatedAt: now,
            },
            [`userPrivate/${id}`]: {email, createdAt: now, updatedAt: now},
            [`accountAccess/${id}`]: {
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
            [`userStats/${id}`]: {
              rating: 0,
              matchesPlayed: 0,
              wins: 0,
              losses: 0,
              draws: 0,
              winStreak: 0,
              updatedAt: now,
            },
            [`wallets/${id}`]: {coinBalance: 0, updatedAt: now},
            [`userSettings/${id}`]: {
              notificationsEnabled: true,
              soundVolume: 1,
              language: "vi",
              theme: "system",
              updatedAt: now,
            },
          },
        };
      }
    );
  }
  const id = key(input.id);
  return mutate(
    actor,
    "user.update",
    input,
    [`user_${id}`],
    async (now, opId) => {
      const previous = await user(id);
      const auth = await adminAuth.getUser(id);
      if (previous.status === "deleted") {
        throw new HttpsError(
          "failed-precondition",
          "Deleted accounts cannot be edited."
        );
      }
      if (auth.customClaims?.admin === true) {
        throw new HttpsError(
          "failed-precondition",
          "Use administrator profile settings for admin accounts."
        );
      }
      return {
        auth: {uid: id, name, ...(auth.email !== email ? {email} : {})},
        updates: {
          ...audit(actor, "user.update", id, now, opId),
          [`users/${id}/displayName`]: name,
          [`users/${id}/updatedAt`]: now,
          [`userPrivate/${id}/email`]: email,
          [`userPrivate/${id}/updatedAt`]: now,
        },
        result: {
          serverNow: now,
          user: {...previous, name, email, updatedAt: now},
        },
      };
    }
  );
});
export const adminSetUserStatus = endpoint(async (input, actor) => {
  allow(input, ["id", "status", "reason", "requestId"]);
  const id = key(input.id);
  const status = choice(
    input.status,
    ["active", "banned", "deleted"] as const,
    "status"
  );
  const reason = text(input.reason, "reason", 5, 500);
  return mutate(
    actor,
    "user.status",
    input,
    [`user_${id}`],
    async (now, opId) => {
      const before = await user(id);
      const target = await adminAuth.getUser(id);
      // Deny ALL admin moderation: protects self and the last admin without a racy admin count.
      if (id === actor.uid || target.customClaims?.admin === true) {
        throw new HttpsError(
          "failed-precondition",
          "Admin accounts cannot be moderated through this API."
        );
      }
      if (before.status === "deleted") {
        throw new HttpsError(
          "failed-precondition",
          "Deleted accounts cannot be restored or changed."
        );
      }
      const updates: Obj = {
        ...audit(actor, "user.status", id, now, opId, reason),
        [`accountAccess/${id}/status`]: status,
        [`accountAccess/${id}/reason`]: reason,
        [`accountAccess/${id}/updatedAt`]: now,
        [`users/${id}/updatedAt`]: now,
      };
      if (status === "deleted") {
        updates[`users/${id}/displayName`] = "Deleted user";
        updates[`userPrivate/${id}/email`] = "";
      }
      return {
        updates,
        auth: {
          uid: id,
          disabled: status !== "active",
          revoke: true,
          ...(status === "deleted" ? {name: "Deleted user"} : {}),
        },
        result: {serverNow: now},
      };
    }
  );
});
