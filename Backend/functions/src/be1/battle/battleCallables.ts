import {enforceUserSession} from "../auth/userSession";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {activeBattleUser, battleSession, operationId} from "./battleAccess";
import {
  cancelQueuedBattle,
  findQuickBattle,
  flushBattleCoordinator,
  readBattleTicket,
  wireTicket,
} from "./matchmaking";
import {memberBattleResponse, transactBattle} from "./battleService";

const options = {region: "asia-southeast1", maxInstances: 10};

export const findBattle = onCall(options, async (request) => {
  await enforceUserSession(request);
  const uid = request.auth?.uid;
  const name = await activeBattleUser(uid);
  const {kind, requestId, clientSessionId} = request.data || {};
  if (
    !["quick", "daily", "create", "join"].includes(kind) ||
    !operationId(requestId)
  ) {
    throw new HttpsError("invalid-argument", "Invalid matchmaking request.");
  }
  if (kind !== "quick") {
    throw new HttpsError("unimplemented", "Only quick battle is available.");
  }
  const sessionId = battleSession(clientSessionId);
  await flushBattleCoordinator();
  const binding = (
    await adminDb.ref(`battleCoordinator/users/${uid}`).get()
  ).val();
  if (binding?.matchId) {
    await transactBattle(binding.matchId, {
      uid: uid!,
      sessionId,
      action: {type: "heartbeat"},
    });
  }
  const ticket = await findQuickBattle(uid!, name, sessionId, requestId);
  return {serverNow: Date.now(), ticket};
});

export const getBattleTicket = onCall(options, async (request) => {
  await enforceUserSession(request);
  const uid = request.auth?.uid;
  await activeBattleUser(uid);
  const {ticketId, clientSessionId} = request.data || {};
  if (!operationId(ticketId)) {
    throw new HttpsError("invalid-argument", "Invalid ticketId.");
  }
  const sessionId = battleSession(clientSessionId);
  await flushBattleCoordinator();
  const ticket = await readBattleTicket(uid!, ticketId, sessionId);
  if (ticket.matchId) {
    await transactBattle(ticket.matchId, {
      uid: uid!,
      sessionId,
      action: {type: "heartbeat"},
    });
  }
  return {serverNow: Date.now(), ticket: wireTicket(ticket)};
});

export const cancelBattleSearch = onCall(options, async (request) => {
  await enforceUserSession(request);
  const uid = request.auth?.uid;
  await activeBattleUser(uid);
  const {ticketId, clientSessionId} = request.data || {};
  if (!operationId(ticketId)) {
    throw new HttpsError("invalid-argument", "Invalid ticketId.");
  }
  const sessionId = battleSession(clientSessionId);
  const ticket = await cancelQueuedBattle(uid!, ticketId, sessionId);
  if (ticket.matchId) {
    return memberBattleResponse(uid!, ticket.matchId, sessionId, {
      type: "leave",
    });
  }
  return {serverNow: Date.now()};
});
