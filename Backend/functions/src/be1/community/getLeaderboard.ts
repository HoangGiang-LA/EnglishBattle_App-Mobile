import {enforceUserSession} from "../auth/userSession";
import {createHash, randomUUID} from "node:crypto";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {activeBattleUser} from "../battle/battleAccess";
import {runCommunityMaintenance} from "./communityMaintenance";
import {integer} from "./notifications";
import {
  newCursor,
  PAGE_SIZE,
  PAGE_TTL_MS,
  pageKey,
  readCursor,
} from "./pagination";

interface Entry {
  uid: string;
  name: string;
  rating: number;
  rank: number;
}
const makeSnapshot = async (uid: string): Promise<string> => {
  if (
    !(
      await adminDb.ref("communityMaintenance/discovery/ready").get()
    ).val()
  ) {
    await runCommunityMaintenance();
    if (
      !(
        await adminDb.ref("communityMaintenance/discovery/ready").get()
      ).val()
    ) {
      throw new HttpsError("unavailable", "Preparing rankings; retry.");
    }
  }
  const [players, access] = await Promise.all([
    adminDb.ref("leaderboardPlayers").get(),
    adminDb.ref("accountAccess").get(),
  ]);
  const statuses = access.val() || {};
  const entries: Entry[] = Object.entries(players.val() || {})
    .filter(([id]) => ["active", "banned"].includes(statuses[id]?.status))
    .map(([id, raw]) => {
      const p = raw as {name?: string; rating?: number};
      return {
        uid: id,
        name: String(p.name || "Người học").slice(0, 100),
        rating: integer(p.rating),
        rank: 0,
      };
    })
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
    )
    .map((entry, i) => ({...entry, rank: i + 1}));
  const hash = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  const ownerRef = adminDb.ref(`communityOwners/${uid}/ranking`);
  const previous = (await ownerRef.get()).val();
  if (
    previous?.hash === hash &&
    previous.expiresAt > Date.now() + 30000 &&
    (
      await adminDb.ref(`communityRankings/${previous.id}/meta`).get()
    ).exists()
  ) {
    return previous.id;
  }
  const id = randomUUID();
  const expiresAt = Date.now() + PAGE_TTL_MS;
  await adminDb.ref(`communityRankings/${id}`).set({
    expiresAt,
    meta: {uid, expiresAt},
    rows: Object.fromEntries(
      entries.map((entry, i) => [pageKey(i), entry]),
    ),
    ranks: Object.fromEntries(entries.map((entry) => [entry.uid, entry])),
  });
  await ownerRef.set({id, hash, expiresAt});
  return id;
};

export const getLeaderboard = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    await enforceUserSession(request);
    const uid = request.auth?.uid;
    await activeBattleUser(uid);
    const {period, cursor} = request.data || {};
    if (
      !["week", "month"].includes(period) ||
      Object.keys(request.data || {}).some(
        (key) => !["period", "cursor"].includes(key),
      )
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid leaderboard query.",
      );
    }
    const saved =
      cursor == null ?
        null :
        await readCursor(uid!, "leaderboard", cursor);
    if (saved && saved.data.period !== period) {
      throw new HttpsError("invalid-argument", "Cursor period changed.");
    }
    const id = saved?.data.snapshotId || (await makeSnapshot(uid!));
    const offset = saved?.data.offset || 0;
    const ref = adminDb.ref(`communityRankings/${id}`);
    const meta = (await ref.child("meta").get()).val();
    if (!meta || meta.expiresAt <= Date.now() || meta.uid !== uid) {
      throw new HttpsError(
        "failed-precondition",
        "Ranking expired; refresh.",
      );
    }
    const [rows, own] = await Promise.all([
      ref
        .child("rows")
        .orderByKey()
        .startAt(pageKey(offset))
        .limitToFirst(PAGE_SIZE + 1)
        .get(),
      ref.child(`ranks/${uid}`).get(),
    ]);
    const all: Entry[] = [];
    rows.forEach((child) => {
      all.push(child.val());
    });
    const entries = all.slice(0, PAGE_SIZE);
    const self = own.val() as Entry | null;
    // Names of accounts deleted after this snapshot are redacted immediately.
    await Promise.all(
      [...entries, ...(self ? [self] : [])].map(async (entry) => {
        const status = (
          await adminDb.ref(`accountAccess/${entry.uid}/status`).get()
        ).val();
        if (status === "deleted" || status == null) {
          entry.name = "Tài khoản đã xóa";
        }
      }),
    );
    const nextCursor =
      all.length > PAGE_SIZE ?
        await newCursor(
            uid!,
            "leaderboard",
            {snapshotId: id, offset: offset + PAGE_SIZE, period},
            meta.expiresAt,
        ) :
        null;
    return {
      serverNow: Date.now(),
      page: {
        title: "Rating tích lũy hiện tại",
        entries,
        self,
        nextCursor,
      },
    };
  },
);
