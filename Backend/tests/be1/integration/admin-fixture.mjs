import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
export async function prepareAndroidAdminFixture() {
  assert.equal(process.env.GCLOUD_PROJECT, "demo-englishbattle-finalization");
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, "127.0.0.1:9199");
  assert.equal(process.env.FIREBASE_DATABASE_EMULATOR_HOST, "127.0.0.1:9100");
  assert.equal(process.env.FUNCTIONS_EMULATOR_HOST, "127.0.0.1:5002");
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  const require = createRequire(
    new URL("../../../functions/package.json", import.meta.url),
  );
  const {
    adminAuth: auth,
    adminDb: db,
  } = require("./lib/config/firebaseAdmin.js");
  assert.match(db.ref().toString(), /^http:\/\/127\.0\.0\.1:9100\//);
  const {
    provisionUserProfile,
  } = require("./lib/be1/auth/userProvisioning.js");
  const { deleteApp } = require("firebase-admin/app");
  const password = "EmulatorOnly-" + randomUUID() + "!";
  const suffix = randomUUID();
  const adminEmail = "android-admin-" + suffix + "@example.test";
  const learnerEmail = "android-learner-" + suffix + "@example.test";
  try {
    const admin = await auth.createUser({
      email: adminEmail,
      password,
      displayName: "Android QA admin",
    });
    const learner = await auth.createUser({
      email: learnerEmail,
      password,
      displayName: "Android QA learner",
    });
    await auth.setCustomUserClaims(admin.uid, { admin: true });
    await provisionUserProfile(admin.uid);
    await provisionUserProfile(learner.uid);
    return { adminEmail, learnerEmail, password };
  } finally {
    await deleteApp(db.app);
  }
}
