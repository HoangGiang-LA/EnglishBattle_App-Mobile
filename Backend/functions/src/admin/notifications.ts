import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../config/firebaseAdmin";
import {transactionWithRetry} from "../be1/databaseTransaction";
import {Data} from "./contracts";
import {OperationHandlers} from "./operations";
import {adminSnapshotPage, scanAdminTime} from "./pages";
import {ADMIN_POLICY as P} from "./policy";

/** Global immutable events + an independently persisted inbox watermark and read IDs per actor UID. */
export async function listAdminNotifications(uid: string, query: Data = {}) {
  const ref = adminDb.ref(`adminNotificationInboxes/${uid}`);
  const state = (await transactionWithRetry(ref, (c) => c || {revision: 0, throughAt: 0})).snapshot.val();
  const filters = {unreadOnly: Boolean(query.unreadOnly)};
  return adminSnapshotPage("notifications", uid, query, filters, async () => {
    const control = (await adminDb.ref("adminNotificationControl").get()).val();
    if (!control?.ready) {
      throw new HttpsError("failed-precondition", "Notifications are being built.", {
        reason: "notifications-not-ready",
      });
    }
    const before = (await adminDb.ref("adminNotificationMeta").get()).val();
    if (Object.keys(before?.writers || {}).length) throw new HttpsError("aborted", "Notifications are updating.");
    const asOf = Date.now(); const rows: Data[] = []; let unreadTotal = 0; let found = 0;
    await scanAdminTime("adminNotificationEvents", asOf - P.notificationMs, asOf + 1, (event, id) => {
      if (Number(event.expiresAt) <= asOf || Number(event.publishedAt) > asOf) return;
      found++;
      if (found > P.maxInboxRecords) throw new HttpsError("resource-exhausted", "Inbox exceeds 5,000 retained events.");
      const read = Number(event.publishedAt) <= Number(state.throughAt || 0) || Boolean(state.reads?.[id]);
      if (!read) unreadTotal++;
      if (!filters.unreadOnly || !read) {
        rows.push({id, title: event.title, body: event.body, at: event.at,
          page: event.page, read});
      }
    });
    const [after, inbox] = await Promise.all([adminDb.ref("adminNotificationMeta").get(), ref.get()]);
    if (Number(after.val()?.version || 0) !== Number(before?.version || 0) ||
        Object.keys(after.val()?.writers || {}).length || inbox.val()?.revision !== state.revision) {
      throw new HttpsError("aborted", "Notifications changed. Retry.");
    }
    return {rows, asOf, extras: {unreadTotal, projectionAsOf: Number(control.asOf),
      lagMs: Math.max(0, Date.now() - Number(control.asOf))}};
  }, String(state.revision));
}

export const notificationOperationHandlers: OperationHandlers = {
  adminMarkNotificationsRead: {
    version: 1, target: (_data, _id, actor) => `inbox/${actor.uid}`,
    async run(ctx, data) {
      const event = data.id ? (await adminDb.ref(`adminNotificationEvents/${data.id}`).get()).val() : null;
      if (data.id && (!event || event.expiresAt <= Date.now())) throw new HttpsError("not-found", "Notification not found.");
      await ctx.step("mark_read", async () => {
        await transactionWithRetry(adminDb.ref(`adminNotificationInboxes/${ctx.actor.uid}`), (current) => {
          const c = current || {revision: 0, throughAt: 0}; const reads = {...c.reads};
          for (const [id, raw] of Object.entries(reads)) {
            if (Number((raw as Data).expiresAt) <= Date.now()) delete reads[id];
          }
          if (data.id) {
            const id = String(data.id);
            if (Number(event.publishedAt) <= Number(c.throughAt || 0) || reads[id]) return c;
            if (Object.keys(reads).length >= P.maxInboxRecords) throw new HttpsError("resource-exhausted", "Inbox read limit reached.");
            reads[id] = {readAt: ctx.createdAt, expiresAt: event.expiresAt};
          } else {
            if (Number(c.throughAt || 0) >= Number(data.throughAt)) return c;
            c.throughAt = Number(data.throughAt);
          }
          return {...c, reads, revision: Number(c.revision || 0) + 1};
        });
      });
      return {};
    },
  },
};
