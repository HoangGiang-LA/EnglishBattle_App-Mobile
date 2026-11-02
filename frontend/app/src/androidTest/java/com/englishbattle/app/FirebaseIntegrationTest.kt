package com.englishbattle.app

import androidx.test.platform.app.InstrumentationRegistry
import com.englishbattle.app.data.*
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.functions.FirebaseFunctions
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.UUID

/** Opt-in SDK integration. Named apps point only at the isolated QA emulators. */
class FirebaseIntegrationTest {
    @Test(timeout = 240_000) fun twoFirebaseSdkClientsCompleteLearningAndBattleWithoutTouchingTheLiveSession() = runBlocking {
        assumeTrue("Run npm run test:acceptance -- --android to start the isolated QA services.",
            InstrumentationRegistry.getArguments().getString("acceptanceEmulators") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val originalUid = FirebaseAuth.getInstance().currentUser?.uid
        val apps = mutableListOf<FirebaseApp>()
        val auths = mutableListOf<FirebaseAuth>()
        try {
            val games = (0..1).map { index ->
                val options = FirebaseOptions.Builder()
                    .setProjectId("demo-englishbattle-finalization")
                    .setApplicationId("1:1234567890:android:0123456789abcdef")
                    .setApiKey("AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                    .setDatabaseUrl("https://englishbattleapp-8d764-default-rtdb.asia-southeast1.firebasedatabase.app")
                    .build()
                val app = FirebaseApp.initializeApp(context, options, "acceptance-${UUID.randomUUID()}")
                apps += app
                val auth = FirebaseAuth.getInstance(app).apply { useEmulator("10.0.2.2", 9199) }
                auths += auth
                val functions = FirebaseFunctions.getInstance(app, "asia-southeast1").apply { useEmulator("10.0.2.2", 5002) }
                val db = FirebaseDatabase.getInstance(app).apply { useEmulator("10.0.2.2", 9100) }
                val repository = FirebaseAuthRepository(auth)
                val email = "android-acceptance-${UUID.randomUUID()}@example.test"
                val password = "Qa-${UUID.randomUUID()}!"
                repository.signUp("SDK learner $index", email, password)
                val uid = auth.currentUser!!.uid
                repository.signOut()
                assertNull(auth.currentUser)
                repository.signIn(email, password)
                assertEquals(uid, auth.currentUser!!.uid)
                repository.updateName("SDK learner updated $index")
                repository.resetPassword(email)
                val game = FirebaseGameRepository(ServerClock(), functions)
                game.ensureProfile()
                game.ensureProfile()
                val catalog = withTimeout(20_000) { FirebaseCatalogRepository(db).observe().first { it.categories.size == 4 && it.topics.isNotEmpty() } }
                assertEquals(4, catalog.categories.size)
                assertEquals(0, game.dashboard().coins)
                game
            }
            assertNotEquals(auths[0].currentUser!!.uid, auths[1].currentUser!!.uid)
            val a = games[0]
            val b = games[1]
            val practice = a.start(QuizMode.PRACTICE, "vocabulary_daily_life", UUID.randomUUID().toString())
            assertEquals(10, practice.questions.size)
            assertEquals(practice.questions, a.resume(practice.id).questions)
            var state = practice
            practice.questions.forEachIndexed { index, q ->
                val requestId = UUID.randomUUID().toString()
                a.saveSelection(practice.id, q.id, q.options.first().id, UUID.randomUUID().toString())
                state = a.submit(practice.id, q.id, q.options.first().id, requestId)
                if (index < 9) state = a.advance(practice.id, UUID.randomUUID().toString(), index)
            }
            val result = state.result ?: a.historyDetail(practice.id)
            assertEquals("completed", result.outcome)
            assertEquals(10, result.total)
            assertEquals(1, result.coins)
            assertEquals(10, result.reviews.size)
            assertNotNull(result.durationMs)
            assertEquals(1, a.dashboard().coins)
            assertEquals(practice.id, a.history("learning", null).entries.single().attemptId)
            assertEquals(1, a.coinLedger(null).entries.sumOf { it.delta })
            val stats = a.statistics("week")
            assertEquals(1, stats.current.sessions)
            assertEquals(10, stats.current.answered)
            assertEquals(result.correct, stats.current.correct)

            val searching = a.findMatch("quick", null, UUID.randomUUID().toString())
            val matched = b.findMatch("quick", null, UUID.randomUUID().toString())
            assertEquals("matched", matched.status)
            val id = matched.attemptId!!
            assertEquals(id, a.matchStatus(searching.id).attemptId)
            a.resume(id)
            b.resume(id)
            val first = a.resume(id)
            assertEquals(first.questions, b.resume(id).questions)
            first.questions.forEach { q ->
                val waiting = a.submit(id, q.id, q.options.first().id, UUID.randomUUID().toString())
                assertNull(waiting.receipts.last().correct)
                b.submit(id, q.id, q.options.first().id, UUID.randomUUID().toString())
            }
            val finalA = a.historyDetail(id)
            val finalB = b.historyDetail(id)
            assertEquals("draw", finalA.outcome)
            assertEquals("draw", finalB.outcome)
            assertEquals(finalA.correct, finalB.correct)
            assertEquals(0, finalA.coins)
            assertEquals(0, finalA.ratingDelta)
            assertEquals(finalA, a.historyDetail(id))
            assertEquals(1, a.dashboard().coins)
            assertEquals(2, a.statistics("week").current.sessions)
            assertEquals(id, a.history("battle", null).entries.single().attemptId)
            assertEquals(auths[0].currentUser!!.uid, a.leaderboard("month", null).self?.uid)
            a.markAllNotificationsRead()
            assertEquals(0, a.notifications(null).unreadCount)
        } finally {
            // These are named QA Auth instances; never sign out the default/live app.
            auths.forEach { auth -> runCatching { auth.currentUser?.delete()?.await() }; auth.signOut() }
            apps.forEach(FirebaseApp::delete)
            assertEquals(originalUid, FirebaseAuth.getInstance().currentUser?.uid)
        }
    }
}
