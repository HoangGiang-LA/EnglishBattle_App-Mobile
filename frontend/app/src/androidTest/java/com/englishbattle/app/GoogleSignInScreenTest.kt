package com.englishbattle.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.englishbattle.app.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Button behavior is isolated from the device's actual Google accounts. */
class GoogleSignInScreenTest {
    @get:Rule val compose = createComposeRule()

    @Test fun googleButtonDoesNotRequireEmailOrPasswordAndClearsPreviousErrors() {
        var googleRequests = 0
        var dismissals = 0
        compose.setContent {
            EnglishBattleTheme {
                AuthScreen(Route.Login, AuthState(initializing = false), {}, {},
                    { _, _, _, _ -> }, {}, { dismissals++ }, { googleRequests++ })
            }
        }
        compose.onNodeWithText("Đăng nhập", substring = false).performScrollTo().performClick()
        compose.onNodeWithText("Vui lòng nhập email hợp lệ.").assertExists()
        compose.onNodeWithText("Đăng nhập với Google").performScrollTo().performClick()
        compose.onNodeWithText("Vui lòng nhập email hợp lệ.").assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, googleRequests); assertEquals(1, dismissals) }
    }

    @Test fun googleButtonIsDisabledWhileAuthenticationIsBusy() {
        compose.setContent {
            EnglishBattleTheme {
                AuthScreen(Route.Login, AuthState(busy = true, initializing = false), {}, {},
                    { _, _, _, _ -> }, {}, {}, { error("Must not open another picker") })
            }
        }
        compose.onNodeWithText("Đăng nhập với Google").performScrollTo().assertIsNotEnabled()
    }
}
