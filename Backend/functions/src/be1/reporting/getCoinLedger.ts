import {enforceUserSession} from "../auth/userSession";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {activeBattleUser} from "../battle/battleAccess";
import {newCursor, PAGE_TTL_MS, readCursor} from "../community/pagination";
import {integer} from "../community/notifications";
import {record} from "../practice/contentValidation";
import {readFeed} from "./history";

export const getCoinLedger = onCall(
  {region: "asia-southeast1", maxInstances: 10},
  async (request) => {
    await enforceUserSession(request);
    const uid = request.auth?.uid;
    await activeBattleUser(uid);
    const {cursor} = request.data || {};
    if (Object.keys(request.data || {}).some((key) => key !== "cursor")) {
      throw new HttpsError("invalid-argument", "Invalid ledger query.");
    }
    const token = cursor == null ? null :
      await readCursor(uid!, "coinLedger", cursor);
    const page = await readFeed(`coinLedger/${uid}`, "createdAt", 25,
      (id, value) => {
        const v = record(value);
        return typeof v.label === "string" && v.label.trim() &&
          typeof v.delta === "number" && Number.isSafeInteger(v.delta) &&
          integer(v.createdAt) > 0 ?
          {id, label: v.label, delta: v.delta, createdAt: v.createdAt} : null;
      }, token?.data);
    const nextCursor = page.more && page.boundary.key ?
      await newCursor(uid!, "coinLedger", page.boundary,
        token?.expiresAt || Date.now() + PAGE_TTL_MS) : null;
    return {serverNow: Date.now(), page: {entries: page.entries, nextCursor}};
  });
