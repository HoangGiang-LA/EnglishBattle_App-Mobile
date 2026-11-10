package com.englishbattle.app

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.englishbattle.app.data.*
import com.englishbattle.app.ui.EnglishBattleTheme
import com.englishbattle.app.ui.QuizScreen
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/** UI-only tests; Firebase sessions and stored user data are untouched. */
class QuizTimeoutScreenTest {
    @get:Rule val compose = createComposeRule()
    private val question = QuizQuestion("timeout-q", "v1", "vocabulary", "topic", "Choose an answer",
        listOf(AnswerOption("a", "First choice"), AnswerOption("b", "Second choice")))

    @Test fun choosingImmediatelySavesAndTimeoutRequestsServerGrading() = checkTimeout("b")
    @Test fun noSelectionAlsoResolvesAtTimeout() = checkTimeout(null)

    @Test fun countdownFreezesWhileGradingAndUsesTheNewQuestionDeadline() {
        val clock = AtomicLong(1000)
        val second = question.copy(id = "second-q", prompt = "Choose the next answer")
        val state = mutableStateOf(AttemptState("grading", QuizMode.TEST, "",
            listOf(question, second), 0, 31000))
        val busy = mutableStateOf(false)
        compose.setContent {
            EnglishBattleTheme {
                QuizScreen(LoadState(state.value), busy.value, null, "timeout-test",
                    clock::get, {}, { busy.value = true }, {}, {}, {})
            }
        }
        clock.set(6000)
        compose.waitUntil(5000) { compose.onAllNodesWithText("00:25").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("First choice").performScrollTo().performClick()
        compose.onNodeWithText("Gửi đáp án").performScrollTo().performClick()
        compose.onNodeWithText("Đang gửi...").assertExists()
        clock.set(14000)
        compose.runOnIdle { state.value = state.value.copy(selectedOptionId = "a") }
        compose.onNodeWithText("00:25").assertExists()
        compose.runOnIdle {
            state.value = state.value.copy(index = 1, deadlineAt = 44000)
            busy.value = false
        }
        compose.onNodeWithText("Choose the next answer").assertExists()
        compose.onNodeWithText("00:30").assertExists()
    }

    private fun checkTimeout(option: String?) {
        val clock = AtomicLong(1000)
        val saved = CopyOnWriteArrayList<String>()
        val submitted = CopyOnWriteArrayList<String?>()
        val state = mutableStateOf(AttemptState("timeout", QuizMode.PRACTICE, "topic", listOf(question), 0, 31000))
        compose.setContent {
            EnglishBattleTheme {
                QuizScreen(LoadState(state.value), false, null, "timeout-test", clock::get, {}, { answer ->
                    submitted.add(answer)
                    state.value = state.value.copy(receipts = listOf(AnswerReceipt(question.id, option, option != null)))
                }, {}, {}, {}, saveSelection = saved::add)
            }
        }
        if (option != null) {
            compose.onNodeWithText("Second choice").performScrollTo().performClick()
            compose.runOnIdle { assertEquals(listOf(option), saved.toList()); assertTrue(submitted.isEmpty()) }
        }
        clock.set(31000)
        compose.waitUntil(5000) { submitted.isNotEmpty() }
        compose.runOnIdle {
            // The server resolves its persisted draft at the deadline.
            assertEquals(listOf<String?>(null), submitted.toList())
            if (option == null) assertTrue(saved.isEmpty())
        }
        compose.onNodeWithText("Xem kết quả").performScrollTo().assertIsDisplayed()
    }

    @Test fun resumingRestoresAnUnconfirmedSelection() {
        val a = AttemptState("resume", QuizMode.PRACTICE, "topic", listOf(question), 0, 31000,
            selectedOptionId = "b")
        var submitted: String? = null
        compose.setContent {
            EnglishBattleTheme {
                QuizScreen(LoadState(a), false, null, "timeout-test", { 1000 }, {}, { submitted = it }, {}, {}, {})
            }
        }
        compose.onNodeWithText("Gửi đáp án").performScrollTo().assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("b", submitted) }
    }

    @Test fun battleWaitsForTheOpponentAndKeepsCorrectnessHidden() {
        val a = AttemptState("battle_ui", QuizMode.BATTLE, "", listOf(question), 0, 31000,
            receipts = listOf(AnswerReceipt(question.id, "b", null)), status = "waiting",
            opponentName = "Opponent", reconnectDeadlineAt = 31000)
        val selections = mutableListOf<String>()
        compose.setContent {
            EnglishBattleTheme {
                QuizScreen(LoadState(a), false, null, "battle-test", { 1000 }, {}, {}, {}, {}, {},
                    saveSelection = selections::add)
            }
        }
        compose.onNodeWithText("Đang chờ đối thủ hoặc kết quả trận đấu...").performScrollTo().assertExists()
        compose.onAllNodesWithText("— pts").assertCountEquals(2)
        compose.onNodeWithText("Second choice").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(selections.isEmpty()) }
        compose.onNodeWithText("Chính xác!").assertDoesNotExist()
        compose.onNodeWithText("Thời hạn trở lại trận:", substring = true).assertDoesNotExist()
    }

    @Test fun reconnectCountdownAppearsWhenServerHeartbeatsStop() {
        val clock = AtomicLong(1000)
        val a = AttemptState("battle_reconnect", QuizMode.BATTLE, "", listOf(question), 0, 31000,
            opponentName = "Opponent", reconnectDeadlineAt = 31000)
        compose.setContent {
            EnglishBattleTheme {
                QuizScreen(LoadState(a), false, null, "battle-test", clock::get, {}, {}, {}, {}, {})
            }
        }
        compose.onNodeWithText("Thời hạn trở lại trận:", substring = true).assertDoesNotExist()
        clock.set(9000)
        compose.waitUntil(5000) {
            compose.onAllNodesWithText("Thời hạn trở lại trận:", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Thời hạn trở lại trận: 22 giây").assertExists()
    }

    @Test fun reconnectCountdownKeepsTickingAfterTheQuestionTimerReachesZero() {
        val clock = AtomicLong(31000)
        val a = AttemptState("battle_late_reconnect", QuizMode.BATTLE, "", listOf(question), 0, 31000,
            status = "waiting", opponentName = "Opponent", reconnectDeadlineAt = 50000)
        compose.setContent {
            EnglishBattleTheme {
                QuizScreen(LoadState(a), false, null, "battle-test", clock::get, {}, {}, {}, {}, {})
            }
        }
        compose.onNodeWithText("Thời hạn trở lại trận: 19 giây").assertExists()
        clock.set(40000)
        compose.waitUntil(5000) {
            compose.onAllNodesWithText("Thời hạn trở lại trận: 10 giây").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("00:00").assertExists()
    }
}
