package com.englishbattle.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import com.englishbattle.app.data.AndroidNotificationSettingsRepository
import com.englishbattle.app.data.NotificationPermissionStatus
import com.englishbattle.app.data.NotificationSettingsRepository
import com.englishbattle.app.ui.*
import org.junit.Assert.*
import org.junit.Assume.assumeFalse
import org.junit.Rule
import org.junit.Test

class NotificationSettingsScreenTest {
    @get:Rule val compose = createComposeRule()

    private class SettingsRepository : NotificationSettingsRepository {
        override var enabled = false
        override var permissionRequested = false
        override var lastNotificationAt = 0L
        override fun permissionStatus() = NotificationPermissionStatus(true, true, true)
        override fun cancelNotifications() {}
    }

    @Test fun everyEnableRequiresConsentAndDecliningKeepsTheSwitchOff() {
        val model = NotificationSettingsViewModel(SettingsRepository())
        compose.setContent {
            val state by model.state.collectAsState()
            EnglishBattleTheme {
                NotificationSetting(state, model::setEnabled, { model.confirmEnable(false) },
                    model::dismissConfirmation, model::openSystemSettings)
            }
        }
        compose.onNodeWithTag("notification-switch").assertIsOff().performClick()
        compose.onNodeWithText("Cho phép gửi thông báo?").assertIsDisplayed()
        compose.onNodeWithTag("notification-switch").assertIsOff()
        compose.onNodeWithText("Không đồng ý").performClick()
        compose.onNodeWithTag("notification-switch").assertIsOff().performClick()
        compose.onNodeWithText("Đồng ý", substring = false).performClick()
        compose.onNodeWithTag("notification-switch").assertIsOn().performClick()
        compose.onNodeWithTag("notification-switch").assertIsOff().assertIsNotEnabled()
        compose.runOnIdle { model.consumeAction(); model.onSystemUiResult() }
        compose.onNodeWithTag("notification-switch").performClick()
        compose.onNodeWithText("Cho phép gửi thông báo?").assertIsDisplayed()
        compose.onNodeWithText("Không đồng ý").performClick()
        compose.onNodeWithTag("notification-switch").assertIsOff()
        compose.runOnIdle { assertFalse(model.state.value.enabled) }
    }

    @Test @SdkSuppress(minSdkVersion = 33)
    fun androidPermissionDialogGrantEnablesTheSwitch() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val preferenceKey = "notification_permission_flow_test"
        context.getSharedPreferences(preferenceKey, android.content.Context.MODE_PRIVATE).edit().clear().commit()
        val repository = AndroidNotificationSettingsRepository(context, preferenceKey) {}
        // Run on a clean test installation, or revoke POST_NOTIFICATIONS before starting instrumentation.
        assumeFalse(repository.permissionStatus().canPost)
        val model = NotificationSettingsViewModel(repository)
        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        compose.setContent {
            val state by model.state.collectAsState()
            val activityContext = LocalContext.current
            EnglishBattleTheme {
                NotificationSettingsEffects(model, state)
                NotificationSetting(state, model::setEnabled,
                    { model.confirmEnable(activityContext.canShowNotificationPermissionRationale()) },
                    model::dismissConfirmation, model::openSystemSettings)
            }
        }
        compose.waitUntil(10_000) { !model.state.value.syncing }

        fun clickSystemPermissionButton(buttonId: String) {
            fun nodes(node: AccessibilityNodeInfo?): List<AccessibilityNodeInfo> =
                if (node == null) emptyList() else listOf(node) + (0 until node.childCount).flatMap { nodes(node.getChild(it)) }
            val deadline = SystemClock.uptimeMillis() + 10_000
            while (SystemClock.uptimeMillis() < deadline) {
                automation.clearCache()
                val root = automation.rootInActiveWindow
                val button = listOf("com.google.android.permissioncontroller", "com.android.permissioncontroller")
                    .firstNotNullOfOrNull { root?.findAccessibilityNodeInfosByViewId("$it:id/$buttonId")?.firstOrNull() }
                if (button != null && button.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
                SystemClock.sleep(100)
            }
            val hierarchy = nodes(automation.rootInActiveWindow).joinToString("\n") { "${it.viewIdResourceName}: ${it.text}" }
            fail("Android permission dialog did not display $buttonId; state=${model.state.value}; hierarchy=\n$hierarchy")
        }

        compose.onNodeWithTag("notification-switch").assertIsOff().performClick()
        compose.onNodeWithText("Đồng ý", substring = false).performClick()
        compose.waitForIdle()
        clickSystemPermissionButton("permission_allow_button")
        compose.waitUntil(10_000) { !model.state.value.busy }
        compose.onNodeWithTag("notification-switch").assertIsOn()
        assertTrue(repository.enabled)
        assertTrue(repository.permissionStatus().canPost)
    }
}
