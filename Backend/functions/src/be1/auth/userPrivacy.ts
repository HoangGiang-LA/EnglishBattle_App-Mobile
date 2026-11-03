import {adminDb} from "../../config/firebaseAdmin";

/** Redact at read time; frozen results, grants and question snapshots stay intact. */
export async function visibleOpponentName(matchId: string, viewerUid: string, fallback: string): Promise<string> {
  const players = (await adminDb.ref(`battleRooms/${matchId}/players`).get()).val();
  const opponent = Object.keys(players || {}).find((uid) => uid !== viewerUid);
  if (!opponent) return fallback ? "Người chơi" : "";
  const status = (await adminDb.ref(`accountAccess/${opponent}/status`).get()).val();
  return status === "deleted" || status == null ? "Tài khoản đã xóa" : fallback;
}
