import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mobileContract} from '../contracts/mobile.v1.mjs';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8').replace(/^\uFEFF/, ''));

export function checkPreparation() {
  const seed = readJson('Backend/database/english-battle.seed.json');
  const business = readJson('frontend/contracts/business-rules.v1.json');
  const admin = readJson('frontend/contracts/admin.v1.json');
  const android = readJson('frontend/app/google-services.json');
  const firebase = readJson('.firebaserc');
  const configSource = fs.readFileSync(path.join(root, 'frontend/admin-web/src/firebase/config.ts'), 'utf8');
  const androidSource = fs.readFileSync(path.join(root, 'frontend/app/src/main/java/com/englishbattle/app/data/FirebaseRepositories.kt'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'frontend/app/src/main/java/com/englishbattle/app/EnglishBattleApplication.kt'), 'utf8');
  const adminSource = fs.readFileSync(path.join(root, 'frontend/admin-web/src/domain.ts'), 'utf8');
  const projectId = firebase.projects.default;
  assert.equal(android.project_info.project_id, projectId);
  assert(configSource.includes(`projectId: '${projectId}'`));
  assert(configSource.includes(android.project_info.firebase_url));
  assert(appSource.includes(android.project_info.firebase_url));
  assert(android.client.some(c => c.client_info.android_client_info.package_name === 'com.englishbattle.app'));
  assert.equal(readJson('database.rules.json').rules['.read'], false);
  assert.equal(readJson('database.rules.json').rules['.write'], false);
  const callables = new Set([...androidSource.matchAll(/(?:call|getHttpsCallable)\("([A-Za-z]+)"/g)].map(m => m[1]));
  assert.deepEqual([...callables].sort(), Object.keys(mobileContract.methods).sort());
  const iface = adminSource.split('export interface AdminService {')[1].split('\n}')[0];
  const methods = [...iface.matchAll(/^\s{2}(\w+)\(/gm)].map(m => m[1]);
  assert.deepEqual(methods.sort(), Object.keys(admin.methods).sort());
  for (const [key, value] of Object.entries(business.confirmed)) {
    if (key in seed.appConfig.server) assert.deepEqual(seed.appConfig.server[key], value, `Seed/contract mismatch: ${key}`);
  }
  for (const key of ['leaderboardMetric', 'leaderboardParticipants', 'weekMonthUseSameRanking', 'dailyChallengeExpiresAtNextMidnight', 'bothDisconnectedAfterGraceOutcome'])
    assert.equal(seed.appConfig.server[key], business.confirmed[key], `Missing confirmed setting: ${key}`);
  for (const [mode, id] of [['PRACTICE', 'practiceQuestionCount'], ['TEST', 'testQuestionCount'], ['DAILY', 'dailyChallengeQuestionCount'], ['BATTLE', 'battleQuestionCount']])
    assert.equal(seed.appConfig.server[id], business.confirmed.questionCounts[mode]);
  assert.equal(Object.keys(seed.questions).length, 250);
  assert.equal(Object.keys(seed.topics).length, 25);
  assert.equal(Object.keys(seed.categories).length, 4);
  assert(!('users' in seed) && !('wallets' in seed) && !('battleResults' in seed), 'Seed must not contain fictional runtime activity');
  return {status: 'PASS', projectId, mobileCallables: callables.size, adminMethods: methods.length,
    questions: 250, topics: 25, skills: 4, liveBattleKinds: business.phaseOne.liveBattleKinds,
    cloudDataVerified: false, cloudRulesChanged: false, backendImplemented: false};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(checkPreparation(), null, 2));
