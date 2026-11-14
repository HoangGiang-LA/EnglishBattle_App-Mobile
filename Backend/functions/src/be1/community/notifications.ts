import {adminDb} from "../../config/firebaseAdmin";
import {contentId, record} from "../practice/contentValidation";
import {transactionWithRetry} from "../databaseTransaction";

export const destinations = [
  "Achievements",
  "Challenge",
  "Practice",
  "Battle",
  "Leaderboard",
  "History",
  "Wallet",
] as const;
export interface NotificationView {
  id: string;
  title: string;
  body: string;
  destination: (typeof destinations)[number];
  read: boolean;
  createdAt: number;
}
interface Counts {
  initializedAt: number;
  totalCount: number;
  unreadCount: number;
  records: Record<string, {readAt: number; createdAt: number}>;
  pendingReads?: Record<string, number>;
}
export const integer = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

export const notificationView = (
  id: string,
  raw: unknown,
): NotificationView | null => {
  const n = record(raw);
  if (
    !contentId(id) ||
    id.length > 512 ||
    typeof n.title !== "string" ||
    !n.title.trim() ||
    n.title.length > 512 ||
    typeof n.body !== "string" ||
    !destinations.includes(
      n.targetType as (typeof destinations)[number],
    ) ||
    typeof n.createdAt !== "number" ||
    !Number.isSafeInteger(n.createdAt) ||
    n.createdAt < 0
  ) {
    return null;
  }
  return {
    id,
    title: n.title,
    body: n.body,
    destination: n.targetType as (typeof destinations)[number],
    read: integer(n.readAt) > 0,
    createdAt: n.createdAt,
  };
};

const baselineCounts = async (uid: string): Promise<Counts> => {
  const values =
    (await adminDb.ref(`notifications/${uid}`).get()).val() || {};
  const records: Counts["records"] = {};
  let unreadCount = 0;
  for (const [id, raw] of Object.entries(values)) {
    const item = notificationView(id, raw);
    if (!item) continue;
    records[id] = {
      readAt: integer(record(raw).readAt),
      createdAt: item.createdAt,
    };
    if (!item.read) unreadCount++;
  }
  return {
    initializedAt: Date.now(),
    records,
    totalCount: Object.keys(records).length,
    unreadCount,
  };
};

export const notificationCounts = async (
  uid: string,
): Promise<Counts> => {
  const ref = adminDb.ref(`notificationCounts/${uid}`);
  const stored = (await ref.get()).val();
  if (stored?.initializedAt) {
    return {...stored, records: stored.records || {}};
  }
  const baseline = await baselineCounts(uid);
  const tx = await transactionWithRetry(
    ref,
    (s) => s || structuredClone(baseline),
  );
  return {...tx.snapshot.val(), records: tx.snapshot.val().records || {}};
};

const recordNotification = async (
  uid: string,
  item: NotificationView,
  sourceReadAt: number,
  intent = false,
) => {
  await notificationCounts(uid);
  const tx = await transactionWithRetry(
    adminDb.ref(`notificationCounts/${uid}`),
    (s: Counts | null) => {
      if (!s) return s;
      s.records ||= {};
      const previous = s.records[item.id];
      const readAt = integer(previous?.readAt) || sourceReadAt;
      if (!previous) {
        s.totalCount++;
        if (!readAt) s.unreadCount++;
      } else if (!integer(previous.readAt) && readAt) {
        s.unreadCount = Math.max(0, s.unreadCount - 1);
      }
      s.records[item.id] = {readAt, createdAt: item.createdAt};
      if (intent && readAt) {
        s.pendingReads ||= {};
        s.pendingReads[item.id] = readAt;
      }
      return s;
    },
  );
  return tx.snapshot.val() as Counts;
};

export const drainNotificationReads = async (
  uid: string,
): Promise<void> => {
  const pending =
    (
      await adminDb.ref(`notificationCounts/${uid}/pendingReads`).get()
    ).val() || {};
  const completed: Array<[string, number]> = [];
  for (const [id, raw] of Object.entries(pending).slice(0, 50)) {
    const at = integer(raw);
    await transactionWithRetry(
      adminDb.ref(`notifications/${uid}/${id}`),
      (n) => {
        if (!n) return n;
        return integer(n.readAt) ? n : {...n, readAt: at};
      },
    );
    completed.push([id, at]);
  }
  if (!completed.length) return;
  // All counter decisions use one transaction boundary. Child transactions
  // competing with this parent can repeatedly invalidate each other's hashes.
  await transactionWithRetry(adminDb.ref(`notificationCounts/${uid}`),
    (s: Counts | null) => {
      if (!s) return s;
      for (const [id, at] of completed) {
        if (s.pendingReads?.[id] === at) delete s.pendingReads[id];
      }
      return s;
    });
};

export const publishNotification = async (
  uid: string,
  id: string,
  value: Record<string, unknown>,
): Promise<void> => {
  if (!notificationView(id, value)) {
    throw new Error("Invalid notification.");
  }
  const tx = await transactionWithRetry(
    adminDb.ref(`notifications/${uid}/${id}`),
    (n) => n || value,
  );
  const stored = tx.snapshot.val();
  const item = notificationView(id, stored);
  if (item) await recordNotification(uid, item, integer(stored.readAt));
};

// Consent and insertion share one mailbox transaction.
export const publishSubscribedNotification = async (
  uid: string, id: string, value: Record<string, unknown>,
): Promise<boolean> => {
  if (!notificationView(id, value)) throw new Error("Invalid notification.");
  const tx = await transactionWithRetry(adminDb.ref(`notifications/${uid}`),
    (current) => {
      if (current?.[id] || current?._settings?.enabled !== true) return current;
      return {...current, [id]: value};
    });
  const stored = tx.snapshot.val()?.[id];
  const item = notificationView(id, stored);
  if (!item) return false;
  await recordNotification(uid, item, integer(stored.readAt));
  return true;
};

export const readNotification = async (uid: string, id: string) => {
  const stored = (
    await adminDb.ref(`notifications/${uid}/${id}`).get()
  ).val();
  const item = notificationView(id, stored);
  if (!item) return;
  await recordNotification(
    uid,
    item,
    integer(stored.readAt) || Date.now(),
    !integer(stored.readAt),
  );
};

export const readAllNotifications = async (uid: string) => {
  await notificationCounts(uid);
  const at = Date.now();
  await transactionWithRetry(
    adminDb.ref(`notificationCounts/${uid}`),
    (s: Counts | null) => {
      if (!s) return s;
      s.pendingReads ||= {};
      for (const [id, value] of Object.entries(s.records || {})) {
        if (integer(value.readAt)) continue;
        value.readAt = at;
        s.pendingReads[id] = at;
      }
      s.unreadCount = 0;
      return s;
    },
  );
};

export const notificationViews = (
  values: unknown,
  counts: Counts,
): NotificationView[] =>
  Object.entries(record(values))
    .flatMap(([id, n]) => {
      const view = notificationView(id, n);
      return view ?
        [
          {
            ...view,
            read: view.read || integer(counts.records[id]?.readAt) > 0,
          },
        ] :
        [];
    })
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );

export const notificationSlice = async (
  uid: string,
  counts: Counts,
  size: number,
  boundary?: {time: number; key?: string},
) => {
  let time = boundary?.time ?? Number.MAX_SAFE_INTEGER;
  let key = boundary?.key;
  const items: NotificationView[] = [];
  let more = false;
  const batchSize = size * 2 + 1;
  for (let scan = 0; scan < 4 && items.length <= size; scan++) {
    const page = await adminDb
      .ref(`notifications/${uid}`)
      .orderByChild("createdAt")
      .startAt(0)
      .endAt(time, key)
      .limitToLast(batchSize)
      .get();
    const rows: Array<{id: string; value: {createdAt: number}}> = [];
    page.forEach((child) => {
      if (child.key !== key || child.val().createdAt !== time) {
        rows.push({id: child.key!, value: child.val()});
      }
    });
    rows.reverse();
    more = rows.length >= batchSize - (key ? 1 : 0);
    for (const row of rows) {
      const valid = notificationViews({[row.id]: row.value}, counts);
      if (valid.length) items.push(valid[0]);
      time = row.value.createdAt;
      key = row.id;
      if (items.length > size) break;
    }
    if (!more || items.length > size) break;
  }
  const entries = items.slice(0, size);
  if (items.length > size) {
    more = true;
    const last = entries[entries.length - 1];
    time = last.createdAt;
    key = last.id;
  }
  return {entries, more, time, key};
};
