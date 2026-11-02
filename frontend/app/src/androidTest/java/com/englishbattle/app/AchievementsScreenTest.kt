package com.englishbattle.app

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.englishbattle.app.data.Achievement
import com.englishbattle.app.data.Dashboard
import com.englishbattle.app.data.LoadState
import com.englishbattle.app.ui.AchievementsScreen
import com.englishbattle.app.ui.EnglishBattleTheme
import org.junit.Rule
import org.junit.Test

class AchievementsScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun practiceBadgeUsesItsTopicProgressAndShowsTheUnlockedMilestone() {
        val topic = "vocabulary_daily_life"
        val badge = Achievement("practice_20_$topic", "Chăm chỉ", "Hoàn thành 20 lần", false, progress = 19)
        val dashboard = mutableStateOf(Dashboard(progress = mapOf(topic to 19), achievements = listOf(badge)))
        compose.setContent {
            EnglishBattleTheme { AchievementsScreen(LoadState(dashboard.value), {}, {}) }
        }
        compose.onNodeWithText("19 / 20").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("0 / 1 huy hiệu").performScrollTo().assertIsDisplayed()
        compose.runOnIdle {
            dashboard.value = Dashboard(progress = mapOf(topic to 21), achievements = listOf(badge.copy(unlocked = true, progress = 21)))
        }
        compose.onNodeWithText("Đã mở khóa").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("1 / 1 huy hiệu").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("19 / 20").assertDoesNotExist()
    }
}
