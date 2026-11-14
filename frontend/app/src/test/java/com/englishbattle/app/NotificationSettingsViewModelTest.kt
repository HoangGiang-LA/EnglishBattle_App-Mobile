package com.englishbattle.app

import androidx.lifecycle.SavedStateHandle
import com.englishbattle.app.data.*
import com.englishbattle.app.ui.*
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first

class NotificationSettingsViewModelTest {
    private class SettingsRepository : NotificationSettingsRepository {
        override var enabled = false
        override var permissionRequested = false
        override var lastNotificationAt = 0L
        var status = NotificationPermissionStatus(true, false, false)
        var cancelled = 0
        var syncNeeded = false
        var syncAction: suspend () -> Unit = { syncNeeded = false }
        override val needsSynchronization get() = syncNeeded
        override suspend fun synchronizePreference() { syncAction() }
        override fun permissionStatus() = status
        override fun cancelNotifications() { cancelled++ }
        fun allow() { status = NotificationPermissionStatus(true, true, true) }
    }

    private fun request(model: NotificationSettingsViewModel, rationale: Boolean = false): NotificationSettingsAction? {
        model.setEnabled(true)
        model.confirmEnable(rationale)
        return model.consumeAction()
    }

    @Test fun staleEnabledPreferenceCannotOverrideDeniedAndroidPermission() {
        val repository = SettingsRepository().apply { enabled = true }
        val model = NotificationSettingsViewModel(repository)
        assertFalse(model.state.value.enabled)
        assertFalse(repository.enabled)
    }

    @Test fun cancellingTheConfirmationNeverEnablesNotificationsOrRequestsPermission() {
        val repository = SettingsRepository().apply { allow() }
        val model = NotificationSettingsViewModel(repository)
        repeat(2) {
            model.setEnabled(true)
            assertTrue(model.state.value.confirmEnable)
            assertFalse(model.state.value.enabled)
            model.dismissConfirmation()
            assertFalse(repository.enabled)
            assertNull(model.consumeAction())
        }
        assertFalse(repository.permissionRequested)
    }

    @Test fun firstRequestStaysOffUntilAndroidActuallyGrantsPermission() {
        val repository = SettingsRepository()
        val model = NotificationSettingsViewModel(repository)
        assertEquals(NotificationSettingsAction.RequestPermission, request(model))
        assertFalse(repository.enabled)
        assertTrue(model.state.value.busy)
        assertTrue(repository.permissionRequested)
        assertNull(model.consumeAction())
        repository.allow()
        model.onSystemUiResult()
        assertTrue(repository.enabled)
        assertTrue(model.state.value.enabled)
        assertFalse(model.state.value.busy)
        assertTrue(NotificationSettingsViewModel(repository).state.value.enabled)
    }

    @Test fun denialOrDismissalOfAndroidDialogKeepsNotificationsOff() {
        val repository = SettingsRepository()
        val model = NotificationSettingsViewModel(repository)
        request(model)
        model.onSystemUiResult()
        assertFalse(repository.enabled)
        assertFalse(model.state.value.enabled)
        assertFalse(model.state.value.busy)
        assertNull(model.state.value.action)
    }

    @Test fun grantingRuntimePermissionWhileSystemNotificationsAreBlockedDoesNotEnable() {
        val repository = SettingsRepository()
        val model = NotificationSettingsViewModel(repository)
        request(model)
        repository.status = NotificationPermissionStatus(true, true, false)
        model.onSystemUiResult()
        assertFalse(repository.enabled)
        assertFalse(model.state.value.enabled)
    }

    @Test fun disablingCancelsAlertsImmediatelyAndRequestsAndroidSettings() {
        val repository = SettingsRepository().apply { allow(); enabled = true }
        val model = NotificationSettingsViewModel(repository)
        model.setEnabled(false)
        assertFalse(repository.enabled)
        assertFalse(model.state.value.enabled)
        assertEquals(1, repository.cancelled)
        assertEquals(NotificationSettingsAction.DisableInSettings, model.consumeAction())
        // Returning without changing the Android switch must not undo the in-app opt-out.
        model.onSystemUiResult()
        assertFalse(model.state.value.enabled)
        assertTrue(model.state.value.message!!.contains("Quyền Android vẫn đang bật"))
        model.setEnabled(true)
        assertTrue(model.state.value.confirmEnable)
        assertFalse(model.state.value.enabled)
        model.confirmEnable(false)
        assertTrue(model.state.value.enabled)
    }

    @Test fun reEnablingAfterSystemRevocationRequestsPermissionOrSettingsAfterConfirmation() {
        val repository = SettingsRepository().apply { allow(); enabled = true; permissionRequested = true }
        val model = NotificationSettingsViewModel(repository)
        model.setEnabled(false)
        model.consumeAction()
        repository.status = NotificationPermissionStatus(true, false, false)
        model.onSystemUiResult()
        model.setEnabled(true)
        assertTrue(model.state.value.confirmEnable)
        assertFalse(model.state.value.enabled)
        model.confirmEnable(false)
        assertEquals(NotificationSettingsAction.EnableInSettings, model.consumeAction())
        repository.allow()
        model.onResume()
        assertTrue(model.state.value.enabled)
    }

    @Test fun aDeniedPermissionCanBeRequestedAgainWhenAndroidAllowsTheDialog() {
        val repository = SettingsRepository().apply { permissionRequested = true }
        val model = NotificationSettingsViewModel(repository)
        assertEquals(NotificationSettingsAction.RequestPermission, request(model, rationale = true))
    }

    @Test fun permanentlyDeniedPermissionUsesSettingsAndReturningWithoutGrantStaysOff() {
        val repository = SettingsRepository().apply { permissionRequested = true }
        val model = NotificationSettingsViewModel(repository)
        assertEquals(NotificationSettingsAction.EnableInSettings, request(model))
        model.onSystemUiResult()
        assertFalse(model.state.value.enabled)
        assertFalse(repository.enabled)
    }

    @Test fun olderAndroidUsesConfirmationWhenAllowedAndSettingsWhenBlocked() {
        val repository = SettingsRepository().apply { status = NotificationPermissionStatus(false, true, true) }
        val model = NotificationSettingsViewModel(repository)
        assertNull(request(model))
        assertTrue(model.state.value.enabled)
        repository.status = NotificationPermissionStatus(false, true, false)
        model.onResume()
        assertFalse(model.state.value.enabled)
        assertEquals(NotificationSettingsAction.EnableInSettings, request(model))
    }

    @Test fun externalPermissionRevocationUpdatesAndPersistsTheOffStateOnResume() {
        val repository = SettingsRepository().apply { allow(); enabled = true }
        val model = NotificationSettingsViewModel(repository)
        repository.status = NotificationPermissionStatus(true, false, false)
        model.onResume()
        assertFalse(model.state.value.enabled)
        assertFalse(repository.enabled)
        repository.allow()
        model.onResume()
        assertFalse(model.state.value.enabled)
    }

    @Test fun pendingEnableSurvivesViewModelRecreationWhileAndroidSettingsAreOpen() {
        val repository = SettingsRepository().apply { permissionRequested = true }
        val savedState = SavedStateHandle()
        request(NotificationSettingsViewModel(repository, savedState))
        // Copy the saved values to simulate a new ViewModel after process recreation.
        val restored = SavedStateHandle(savedState.keys().associateWith { savedState.get<Any?>(it) })
        val model = NotificationSettingsViewModel(repository, restored)
        repository.allow()
        model.onResume()
        assertTrue(model.state.value.enabled)
        assertFalse(model.state.value.busy)
        model.onSystemUiResult() // A late ActivityResult must be harmless.
        assertTrue(model.state.value.enabled)
    }

    @Test fun failedSystemLaunchDoesNotLeaveTheSwitchEnabledOrBusy() {
        val repository = SettingsRepository()
        val model = NotificationSettingsViewModel(repository)
        request(model)
        model.onLaunchFailed()
        assertFalse(model.state.value.enabled)
        assertFalse(model.state.value.busy)
        assertNotNull(model.state.value.message)
        model.setEnabled(true)
        assertTrue(model.state.value.confirmEnable)
    }

    @Test fun notificationDeliveryChecksPermissionAndDoesNotReplayMutedAlerts() {
        val repository = SettingsRepository().apply { allow() }
        val model = NotificationSettingsViewModel(repository)
        val first = AppNotification("one", "First", "Body", "History", false, 100)
        assertNull(model.consumeLatestNotification(listOf(first)))
        request(model)
        assertNull(model.consumeLatestNotification(listOf(first)))
        val second = first.copy(id = "two", title = "Second", createdAt = 200)
        assertEquals("Second", model.consumeLatestNotification(listOf(first, second)))
        repository.status = NotificationPermissionStatus(true, false, false)
        assertNull(model.consumeLatestNotification(listOf(second.copy(createdAt = 300))))
        assertFalse(model.state.value.enabled)
    }

    @Test fun managingSettingsDoesNotOptInWithoutAnEnableConfirmation() {
        val repository = SettingsRepository()
        val model = NotificationSettingsViewModel(repository)
        model.openSystemSettings()
        assertEquals(NotificationSettingsAction.ManageInSettings, model.consumeAction())
        repository.allow()
        model.onSystemUiResult()
        assertFalse(repository.enabled)
    }

    @Test fun enablingWaitsForTheServerToConfirmItsNotificationPreference() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val repository = SettingsRepository().apply {
            allow(); enabled = true; syncNeeded = true
            syncAction = { gate.await(); syncNeeded = false }
        }
        val model = NotificationSettingsViewModel(repository)
        assertTrue(model.state.value.syncing)
        assertFalse(model.state.value.enabled)
        gate.complete(Unit)
        withTimeout(5_000) { model.state.first { !it.syncing && it.enabled } }
        Unit
    }

    @Test fun aFailedPreferenceSyncRemainsOffAndCanRetry() = runBlocking {
        val repository = SettingsRepository().apply {
            allow(); enabled = true; syncNeeded = true
            syncAction = { throw java.io.IOException("Offline") }
        }
        val model = NotificationSettingsViewModel(repository)
        withTimeout(5_000) { model.state.first { it.syncFailed } }
        assertFalse(model.state.value.enabled)
        repository.syncAction = { repository.syncNeeded = false }
        model.synchronizePreference()
        withTimeout(5_000) { model.state.first { !it.syncing && it.enabled } }
        assertFalse(model.state.value.syncFailed)
    }
}
