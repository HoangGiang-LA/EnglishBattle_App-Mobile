import assert from "node:assert/strict";

const projectId = "englishbattleapp-8d764";
const namespace = `${projectId}-default-rtdb`;

const authUrl = "http://127.0.0.1:9099";
const dbUrl = "http://127.0.0.1:9000";

const functionUrl =
  `http://127.0.0.1:5001/${projectId}/` +
  "asia-southeast1/ensureUserProfile";

// 1. Tao tai khoan test moi trong Auth Emulator
async function createTestUser() {
  const email = `be1-test-${Date.now()}@example.com`;

  const response = await fetch(
    `${authUrl}/identitytoolkit.googleapis.com/v1/` +
      "accounts:signUp?key=fake-api-key",
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        email,
        password: "TestOnly123!",
        returnSecureToken: true,
      }),
    }
  );

  assert.equal(response.status, 200);
  return response.json();
}

// 2. Goi Cloud Function voi Firebase ID Token
async function ensureProfile(idToken) {
  const response = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({data: {}}),
  });

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(typeof payload.result.serverNow, "number");
}

// 3. Doc du lieu tu Database Emulator
async function readDatabase(path) {
  const response = await fetch(
    `${dbUrl}/${path}.json?ns=${namespace}`,
    {
      headers: {
        Authorization: "Bearer owner",
      },
    }
  );

  assert.equal(response.status, 200);
  return response.json();
}

// 4. Chay kiem thu
async function main() {
  const user = await createTestUser();
  const uid = user.localId;

  console.log("PASS: Created test account");


async function deleteTestNode(path) {
  const response = await fetch(
    `${dbUrl}/${path}.json?ns=${namespace}`,
    {
      method: "DELETE",
      headers: {
        Authorization: "Bearer owner",
      },
    }
  );

  assert.equal(
    response.status,
    200,
    `Failed to delete test node: ${path}`
  );
}

  // Gui 5 request dong thoi vao tai khoan moi
  const results = await Promise.allSettled(
    Array.from({length: 5}, () =>
      ensureProfile(user.idToken)
    )
  );

  const failures = results.filter(
    (result) => result.status === "rejected"
  );

  assert.equal(
    failures.length,
    0,
    `Concurrent requests failed: ${failures.length}`
  );

  console.log("PASS: Five concurrent requests on new account");


  const paths = [
    "users",
    "userPrivate",
    "accountAccess",
    "userStats",
    "wallets",
    "userSettings",
  ];

  const before = {};

  for (const path of paths) {
    const data = await readDatabase(`${path}/${uid}`);
    assert.ok(data, `Missing data: ${path}`);
    before[path] = data;
  }

  assert.equal(before.accountAccess.status, "active");
  assert.equal(before.userStats.rating, 0);
  assert.equal(before.wallets.coinBalance, 0);

  console.log("PASS: Six profile nodes created");

  // Goi lai API va kiem tra khong ghi de
  await ensureProfile(user.idToken);

  for (const path of paths) {
    const after = await readDatabase(`${path}/${uid}`);
    assert.deepEqual(after, before[path]);
  }

  console.log("PASS: Repeated call preserves profile");

  // Mo phong ho so bi thieu node userSettings
  await deleteTestNode(`userSettings/${uid}`);

  const missingSettings = await readDatabase(
    `userSettings/${uid}`
  );

  assert.equal(missingSettings, null);

  // Goi lai API de khoi phuc node bi thieu
  await ensureProfile(user.idToken);

  const restoredSettings = await readDatabase(
    `userSettings/${uid}`
  );

  assert.ok(restoredSettings);
  assert.equal(restoredSettings.notificationsEnabled, false);
  assert.equal(restoredSettings.language, "vi");

  // Dam bao Stats va Wallet van giu nguyen
  assert.deepEqual(
    await readDatabase(`userStats/${uid}`),
    before.userStats
  );

  assert.deepEqual(
    await readDatabase(`wallets/${uid}`),
    before.wallets
  );

  console.log("PASS: Missing profile node recovered");
  console.log("ALL BE1-01 TESTS PASSED");
}

main().catch((error) => {
  console.error("TEST FAILED:", error.message);
  process.exitCode = 1;
});
