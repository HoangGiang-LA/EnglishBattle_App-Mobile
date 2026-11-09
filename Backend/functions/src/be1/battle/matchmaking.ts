import {createHash, randomUUID} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import {adminDb} from "../../config/firebaseAdmin";
import {selectQuestions} from "../practice/startAttempt";
import {
  BattleCoordinator,
  BattleMatch,
  BattleTicket,
  RECONNECT_MS,
  SEARCH_MS,
  WireTicket,
} from "./battleTypes";
import {battleDueAt} from "./battleState";
import {enqueueBattleWork} from "./battleWork";
import {battleNow, syncBattleClock} from "./battleClock";

const ticketIdFor = (uid: string, requestId: string) =>
  "ticket_" +
  createHash("sha256")
    .update(JSON.stringify([uid, requestId]))
    .digest("hex");

export const wireTicket = (ticket: BattleTicket): WireTicket => ({
  id: ticket.id,
  status: ticket.status,
  opponentName: ticket.opponentName || "",
  attemptId: ticket.matchId || null,
  roomCode: null,
});

const expireTickets = (state: BattleCoordinator, now: number) => {
  for (const ticket of Object.values(state.tickets || {})) {
    if (ticket.status !== "searching" || ticket.expiresAt > now) continue;
    ticket.status = "expired";
    if (state.users?.[ticket.uid]?.ticketId === ticket.id) {
      delete state.users[ticket.uid];
    }
  }
  for (const [id, ticket] of Object.entries(state.tickets || {})) {
    if (ticket.publishedAt && now >= ticket.publishedAt + 60000) {
      delete state.tickets![id];
    }
  }
};

/**
 * Publish committed allocations/tickets before clearing the coordinator outbox.
 * @return {Promise<void>} Completion.
 */
export async function flushBattleCoordinator(): Promise<void> {
  await syncBattleClock();
  const ref = adminDb.ref("battleCoordinator");
  const before = await ref.get();
  if (!before.exists()) return;
  const sweep = await ref.transaction(
    (state: BattleCoordinator | null) => {
      if (!state) return state;
      expireTickets(state, battleNow());
      return state;
    },
    undefined,
    false,
  );
  const state = sweep.snapshot.val() as BattleCoordinator | null;
  if (!state) return;
  for (const [id, allocation] of Object.entries(state.allocations || {})) {
    try {
      const created = await adminDb
        .ref(`battleRooms/${id}`)
        .transaction((current) => current || allocation, undefined, false);
      const match = created.snapshot.val() as BattleMatch;
      await enqueueBattleWork(id, battleDueAt(match, battleNow()), true);
      for (const uid of Object.keys(match.players)) {
        if (match.status === "completed") continue;
        await adminDb.ref(`activeBattles/${uid}`).transaction(
          (active) => {
            if (active?.assignedAt > match.createdAt) return;
            return {roomId: id, assignedAt: match.createdAt};
          },
          undefined,
          false,
        );
      }
      // Tickets must be durable before removing a matched allocation.
      for (const ticket of Object.values(state.tickets || {})) {
        if (ticket.matchId === id) {
          await adminDb
            .ref(`battleTickets/${ticket.uid}/${ticket.id}`)
            .set(ticket);
        }
      }
      await ref.transaction(
        (current: BattleCoordinator | null) => {
          if (!current) return current;
          if (!current.allocations?.[id]) return;
          delete current.allocations[id];
          for (const ticket of Object.values(current.tickets || {})) {
            if (ticket.matchId === id) ticket.publishedAt ||= battleNow();
          }
          return current;
        },
        undefined,
        false,
      );
    } catch (error) {
      console.error("Battle allocation retry", {
        id,
        code: (error as {code?: string}).code || "allocation-error",
      });
    }
  }
  for (const ticket of Object.values(state.tickets || {})) {
    if (ticket.publishedAt) continue;
    if (!["cancelled", "expired"].includes(ticket.status)) continue;
    await adminDb.ref(`battleTickets/${ticket.uid}/${ticket.id}`).set(ticket);
    await ref.transaction(
      (current: BattleCoordinator | null) => {
        if (!current) return current;
        if (current.tickets?.[ticket.id]?.status !== ticket.status) return;
        current.tickets[ticket.id].publishedAt ||= battleNow();
        return current;
      },
      undefined,
      false,
    );
  }
}

/**
 * Read a ticket belonging to this UID, including pending outbox writes.
 * @param {string} uid Owner.
 * @param {string} ticketId Ticket.
 * @param {string} sessionId Installation owning the ticket.
 * @return {Promise<BattleTicket>} Authoritative ticket.
 */
export async function readBattleTicket(
  uid: string,
  ticketId: string,
  sessionId: string,
): Promise<BattleTicket> {
  const [queued, saved] = await Promise.all([
    adminDb.ref(`battleCoordinator/tickets/${ticketId}`).get(),
    adminDb.ref(`battleTickets/${uid}/${ticketId}`).get(),
  ]);
  const ticket = (queued.val() || saved.val()) as BattleTicket | null;
  if (!ticket || ticket.uid !== uid) {
    throw new HttpsError("not-found", "Ticket not found.");
  }
  if (ticket.clientSessionId !== sessionId) {
    throw new HttpsError(
      "failed-precondition",
      "Ticket belongs to another session.",
    );
  }
  return ticket;
}

/**
 * Reserve two different UIDs atomically; prepared content is server-owned.
 * @param {string} uid Authenticated owner.
 * @param {string} name Public name.
 * @param {string} sessionId Installation.
 * @param {string} requestId Idempotency key.
 * @return {Promise<WireTicket>} Current ticket.
 */
export async function findQuickBattle(
  uid: string,
  name: string,
  sessionId: string,
  requestId: string,
): Promise<WireTicket> {
  await syncBattleClock();
  const requestStartedAt = battleNow();
  const ticketId = ticketIdFor(uid, requestId);
  const saved = (
    await adminDb.ref(`battleTickets/${uid}/${ticketId}`).get()
  ).val();
  if (saved) {
    return wireTicket(await readBattleTicket(uid, ticketId, sessionId));
  }
  const existing = (
    await adminDb.ref(`battleCoordinator/users/${uid}`).get()
  ).val();
  if (existing?.ticketId) {
    await flushBattleCoordinator();
    return wireTicket(
      await readBattleTicket(uid, existing.ticketId, sessionId),
    );
  }
  const questions = await selectQuestions("BATTLE", null);
  const keys: BattleMatch["keys"] = {};
  for (const question of questions) {
    const answer = (
      await adminDb
        .ref(`questionAnswers/${question.id}/${question.version}`)
        .get()
    ).val();
    if (
      !answer ||
      typeof answer.explanation !== "string" ||
      !answer.explanation.trim() ||
      !question.options.some((o) => o.id === answer.correctOptionId)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Invalid battle answer key.",
      );
    }
    keys[question.id] = {
      correctOptionId: answer.correctOptionId,
      explanation: answer.explanation,
    };
  }
  const matchId = `battle_${randomUUID()}`;
  const tx = await adminDb.ref("battleCoordinator").transaction(
    (current: BattleCoordinator | null) => {
      const now = battleNow();
      if (now - requestStartedAt >= 60000) {
        return;
      }
      const state = current || {};
      state.tickets ||= {};
      state.users ||= {};
      expireTickets(state, now);
      if (state.users[uid] || state.tickets[ticketId]) return state;
      const ticket: BattleTicket = {
        id: ticketId,
        uid,
        name,
        clientSessionId: sessionId,
        status: "searching",
        createdAt: now,
        expiresAt: now + SEARCH_MS,
      };
      state.tickets[ticketId] = ticket;
      state.users[uid] = {ticketId};
      const peer = Object.values(state.tickets)
        .filter(
          (t) =>
            t.uid !== uid &&
            t.status === "searching" &&
            t.expiresAt > now &&
            state.users?.[t.uid]?.ticketId === t.id,
        )
        .sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        )[0];
      if (!peer) return state;
      ticket.status = peer.status = "matched";
      ticket.matchId = peer.matchId = matchId;
      ticket.opponentName = peer.name;
      peer.opponentName = name;
      state.users[uid].matchId = state.users[peer.uid].matchId = matchId;
      const createdAt = now;
      const match: BattleMatch = {
        id: matchId,
        kind: "quick",
        status: "ready",
        questions,
        keys,
        players: {
          [uid]: {name, clientSessionId: sessionId, lastSeenAt: createdAt},
          [peer.uid]: {
            name: peer.name,
            clientSessionId: peer.clientSessionId,
            lastSeenAt: createdAt,
          },
        },
        currentIndex: 0,
        createdAt,
        readyDeadlineAt: createdAt + RECONNECT_MS,
        openedAt: createdAt,
        deadlineAt: createdAt + RECONNECT_MS,
      };
      state.allocations ||= {};
      state.allocations[matchId] = match;
      return state;
    },
    undefined,
    false,
  );
  const state = tx.snapshot.val() as BattleCoordinator;
  if (!tx.committed) {
    throw new HttpsError("deadline-exceeded", "Search request expired.");
  }
  const assignedId = state.tickets?.[ticketId] ?
    ticketId :
    state.users?.[uid]?.ticketId || ticketId;
  await flushBattleCoordinator();
  return wireTicket(await readBattleTicket(uid, assignedId, sessionId));
}

/**
 * Cancel only a searching ticket; matched tickets must use the leave protocol.
 * @param {string} uid Owner.
 * @param {string} ticketId Ticket.
 * @param {string} sessionId Installation.
 * @return {Promise<BattleTicket>} Committed ticket status.
 */
export async function cancelQueuedBattle(
  uid: string,
  ticketId: string,
  sessionId: string,
): Promise<BattleTicket> {
  await syncBattleClock();
  await readBattleTicket(uid, ticketId, sessionId);
  await adminDb.ref("battleCoordinator").transaction(
    (state: BattleCoordinator | null) => {
      if (!state) return state;
      expireTickets(state, battleNow());
      const ticket = state.tickets?.[ticketId];
      if (ticket?.uid !== uid || ticket.status !== "searching") return state;
      ticket.status = "cancelled";
      if (state.users?.[uid]?.ticketId === ticketId) delete state.users[uid];
      return state;
    },
    undefined,
    false,
  );
  await flushBattleCoordinator();
  return readBattleTicket(uid, ticketId, sessionId);
}

/**
 * Release reservations only after both players' settlement is durable.
 * @param {BattleMatch} match Completed match.
 */
export async function releaseBattle(match: BattleMatch): Promise<void> {
  await adminDb.ref("battleCoordinator").transaction(
    (state: BattleCoordinator | null) => {
      if (!state) return state;
      for (const uid of Object.keys(match.players)) {
        if (state.users?.[uid]?.matchId === match.id) delete state.users[uid];
      }
      return state;
    },
    undefined,
    false,
  );
  for (const uid of Object.keys(match.players)) {
    await adminDb.ref(`activeBattles/${uid}`).transaction(
      (active) => {
        if (!active) return active;
        if (active.roomId === match.id) return null;
        return;
      },
      undefined,
      false,
    );
  }
}
