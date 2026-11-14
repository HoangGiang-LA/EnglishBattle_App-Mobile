import {randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminAuth, adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {publishSubscribedNotification} from "../be1/community/notifications";
import {Data} from "./contracts";
import {AdminActor, requireCurrentAdmin} from "./guard";
import {OperationHandlers} from "./operations";
import {notFound} from "./userModel";

const batchSize = 10;
async function campaignQuery<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Index not defined")) {
      throw new HttpsError("failed-precondition", "Campaign database indexes are missing.", {
        reason: "campaign-index-required",
      });
    }
    throw error;
  }
}
const publicCampaign = (c: Data) => Object.fromEntries([
  "id", "kind", "audience", "title", "body", "destination", "coinAmount", "recipientIds", "status",
  "createdAt", "updatedAt", "processed", "delivered", "skipped", "notified", "errorCode",
].filter((key) => c[key] != null).map((key) => [key, c[key]]));

export async function listCampaigns() {
  const snapshot = await campaignQuery(() =>
    adminDb.ref("adminCampaigns").orderByChild("createdAt").limitToLast(20).get());
  const rows: Data[] = [];
  snapshot.forEach((child) => {
    rows.push(publicCampaign(child.val()));
  });
  return rows.reverse();
}

export const campaignOperationHandlers: OperationHandlers = {
  adminCreateCampaign: {
    version: 1, target: (_data, id) => `campaign/${id}`,
    async run(ctx, data) {
      const input = data.input as Data;
      await ctx.step("enqueue", async () => {
        await transactionWithRetry(adminDb.ref(`adminCampaigns/${ctx.id}`), (current) => current || {
          ...input, id: ctx.id, actor: ctx.actor, status: "queued", createdAt: ctx.createdAt,
          updatedAt: ctx.createdAt, nextRunAt: ctx.createdAt, processed: 0, delivered: 0, skipped: 0, notified: 0,
        });
      });
      // Return the immutable accepted request, rather than a worker-dependent response on retry.
      return {campaign: publicCampaign({...input, id: ctx.id, status: "queued", createdAt: ctx.createdAt,
        updatedAt: ctx.createdAt, processed: 0, delivered: 0, skipped: 0, notified: 0})};
    },
  },
};

/** Same authoritative settlement and per-grant wallet projection used by practice/battles. */
export async function grantCampaignCoins(uid: string, campaign: Data) {
  const grantId = `admin_${campaign.id}`;
  const [wallet, grants, progress] = await Promise.all([
    adminDb.ref(`wallets/${uid}`).get(), adminDb.ref(`rewardGrants/${uid}`).get(),
    adminDb.ref(`learningProgress/${uid}`).get(),
  ]);
  const baseline = Object.fromEntries(Object.entries(grants.val() || {}).filter(([, raw]) =>
    (raw as Data).status === "completed").map(([id, raw]) => {
    const g = raw as Data;
    return [id, {attemptId: g.sourceId || id, outcome: "completed", coinDelta: Number(g.coinDelta) || 0,
      correctCount: 0, answeredCount: 0, settledAt: Number(g.grantedAt) || campaign.createdAt}];
  }));
  const tx = await transactionWithRetry(adminDb.ref(`userSettlements/${uid}`), (current) => {
    const s = current || {coinBalance: Number(wallet.val()?.coinBalance) || 0, grants: {...baseline},
      progress: Object.fromEntries(Object.entries(progress.val() || {}).map(([id, raw]) =>
        [id, Number((raw as Data).completedAttempts) || 0])), initializedAt: Date.now()};
    s.grants ||= {};
    if (s.grants[grantId]) return s;
    const balance = Number(s.coinBalance || 0) + Number(campaign.coinAmount);
    if (!Number.isSafeInteger(balance) || balance < 0) throw new HttpsError("out-of-range", "Coin balance is out of range.");
    s.grants[grantId] = {attemptId: campaign.id, sourceType: "admin", outcome: "completed",
      coinDelta: campaign.coinAmount, correctCount: 0, answeredCount: 0, settledAt: campaign.createdAt};
    s.coinBalance = balance;
    return s;
  });
  const settlement = tx.snapshot.val();
  const grant = settlement.grants[grantId];
  await transactionWithRetry(adminDb.ref(`wallets/${uid}`), (current) => {
    if (!current) {
      return {coinBalance: settlement.coinBalance, updatedAt: campaign.createdAt,
        appliedGrants: Object.fromEntries(Object.keys(settlement.grants).map((id) => [id, true]))};
    }
    current.appliedGrants ||= {};
    for (const id of Object.keys(baseline)) current.appliedGrants[id] = true;
    if (current.appliedGrants[grantId]) return current;
    const balance = Number(current.coinBalance || 0) + Number(grant.coinDelta);
    if (!Number.isSafeInteger(balance)) throw new HttpsError("out-of-range", "Coin balance is out of range.");
    return {...current, coinBalance: balance, updatedAt: campaign.createdAt,
      appliedGrants: {...current.appliedGrants, [grantId]: true}};
  });
  await adminDb.ref().update({
    [`coinLedger/${uid}/${grantId}`]: {id: grantId, label: campaign.title,
      delta: grant.coinDelta, createdAt: grant.settledAt},
    [`rewardGrants/${uid}/${grantId}`]: {sourceType: "admin", sourceId: campaign.id,
      coinDelta: grant.coinDelta, status: "completed", grantedAt: grant.settledAt},
  });
}

export async function deliverCampaign(campaign: Data, uid: string): Promise<Data> {
  const receipt = adminDb.ref(`adminCampaignDeliveries/${campaign.id}/${uid}`);
  const previous = (await receipt.get()).val();
  if (previous) return previous;
  const id = `admin_${campaign.id}`;
  const [grant, notice, access, state, profile] = await Promise.all([
    adminDb.ref(`userSettlements/${uid}/grants/${id}`).get(), adminDb.ref(`notifications/${uid}/${id}`).get(),
    adminDb.ref(`accountAccess/${uid}`).get(), adminDb.ref(`adminUserState/${uid}`).get(),
    adminDb.ref(`users/${uid}`).get(),
  ]);
  // Finish projections of an already committed effect, even if account state changed after a crash.
  if (!grant.exists() && !notice.exists()) {
    let user;
    try {
      user = await adminAuth.getUser(uid);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    if (!user || user.disabled || access.val()?.status !== "active" || state.val()?.pendingOperation ||
        (campaign.audience === "all" &&
          (Number(profile.val()?.provisionedAt) || Date.parse(user.metadata.creationTime)) >
          Number(campaign.createdAt))) {
      const result = {delivered: false, notified: false};
      await receipt.set(result);
      return result;
    }
  }
  if (campaign.kind === "coins") await grantCampaignCoins(uid, campaign);
  const notified = await publishSubscribedNotification(uid, id, {
    title: campaign.title, body: campaign.body, targetType: campaign.kind === "coins" ? "Wallet" : campaign.destination,
    createdAt: campaign.createdAt, readAt: 0, sourceType: "admin", sourceId: campaign.id,
  });
  const result = {delivered: campaign.kind === "coins" || notified, notified};
  await transactionWithRetry(receipt, (current) => current || result);
  return result;
}

/** Bounded batches and a durable cursor; a crash replays the batch using per-recipient receipts. */
export async function runCampaignMaintenance() {
  const due = await campaignQuery(() => adminDb.ref("adminCampaigns").orderByChild("nextRunAt")
    .startAt(1).endAt(Date.now()).limitToFirst(3).get());
  const ids: string[] = [];
  due.forEach((child) => {
    ids.push(child.key!);
  });
  for (const id of ids) {
    const ref = adminDb.ref(`adminCampaigns/${id}`); const owner = randomUUID();
    const lease = await transactionWithRetry(ref, (current) => {
      if (!current) return current;
      if (current.leaseUntil > Date.now() || !["queued", "running", "retrying"].includes(current.status)) return;
      return {...current, owner, leaseUntil: Date.now() + 90000, status: "running"};
    });
    if (!lease.committed || lease.snapshot.val()?.owner !== owner) continue;
    const c = lease.snapshot.val();
    try {
      await requireCurrentAdmin(adminAuth, adminDb, c.actor as AdminActor);
      let recipients: string[];
      if (c.audience === "selected") recipients = (c.recipientIds || []).slice(c.processed, c.processed + batchSize);
      else {
        let query = adminDb.ref("users").orderByKey();
        if (c.cursor) query = query.startAfter(c.cursor);
        const page = await query.limitToFirst(batchSize).get();
        recipients = [];
        page.forEach((child) => {
          recipients.push(child.key!);
        });
      }
      const results: Data[] = [];
      for (const uid of recipients) {
        const renewed = await transactionWithRetry(ref, (current) => {
          if (!current) return current;
          if (current.owner !== owner || current.leaseUntil <= Date.now()) return;
          return {...current, leaseUntil: Date.now() + 90000};
        });
        if (!renewed.committed || renewed.snapshot.val()?.owner !== owner) {
          throw new HttpsError("aborted", "Campaign lease lost.");
        }
        await requireCurrentAdmin(adminAuth, adminDb, c.actor as AdminActor);
        const result = await deliverCampaign(c, uid);
        const expected = c.processed + results.length;
        const checkpoint = await transactionWithRetry(ref, (current) => {
          if (!current) return current;
          if (current.owner !== owner || current.leaseUntil <= Date.now() ||
              current.processed !== expected) return;
          return {...current, processed: expected + 1, delivered: current.delivered + (result.delivered ? 1 : 0),
            skipped: current.skipped + (result.delivered ? 0 : 1),
            notified: current.notified + (result.notified ? 1 : 0),
            cursor: uid, updatedAt: Date.now()};
        });
        if (!checkpoint.committed || checkpoint.snapshot.val()?.owner !== owner) {
          throw new HttpsError("aborted", "Campaign checkpoint changed.");
        }
        results.push(result);
      }
      const completed = c.audience === "selected" ? c.processed + recipients.length >= c.recipientIds.length :
        recipients.length < batchSize;
      await transactionWithRetry(ref, (current) => {
        if (!current) return current;
        if (current.owner !== owner || current.leaseUntil <= Date.now()) return;
        return {...current, status: completed ? "completed" : "running",
          nextRunAt: completed ? null : Date.now() + 1000, owner: null, leaseUntil: null,
          errorCode: null, updatedAt: Date.now()};
      });
    } catch (error) {
      const code = error instanceof HttpsError ? error.code : "unavailable";
      const failed = ["permission-denied", "unauthenticated", "out-of-range"].includes(code);
      await transactionWithRetry(ref, (current) => !current ? current : current.owner !== owner ? undefined : {
        ...current, status: failed ? "failed" : "retrying", errorCode: code, owner: null, leaseUntil: null,
        updatedAt: Date.now(), nextRunAt: failed ? null : Date.now() + 5000,
      });
    }
  }
}
