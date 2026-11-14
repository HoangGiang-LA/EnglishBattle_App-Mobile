package com.englishbattle.app.ui

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.englishbattle.app.data.AppNotification
import com.englishbattle.app.data.NotificationSettingsRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

enum class NotificationSettingsAction { RequestPermission, EnableInSettings, DisableInSettings, ManageInSettings }

data class NotificationSettingsState(
    val enabled: Boolean = false,
    val busy: Boolean = false,
    val confirmEnable: Boolean = false,
    val needsSystemSettings: Boolean = false,
    val action: NotificationSettingsAction? = null,
    val message: String? = null,
    val syncing: Boolean = false, val syncFailed: Boolean = false
)

class NotificationSettingsViewModel(
    private val repository: NotificationSettingsRepository,
    private val savedState: SavedStateHandle = SavedStateHandle()
) : ViewModel() {
    private val _state = MutableStateFlow(NotificationSettingsState(busy = savedState.contains(PENDING_ACTION)))
    val state = _state.asStateFlow()
    private var syncJob: Job? = null

    init { refreshPermission(); synchronizePreference() }

    fun synchronizePreference() {
        if (!repository.needsSynchronization || syncJob?.isActive == true) return
        _state.update { it.copy(syncing = true, syncFailed = false, enabled = false) }
        syncJob = viewModelScope.launch(Dispatchers.IO) {
            try {
                repository.synchronizePreference()
                syncJob = null
                _state.update { it.copy(syncing = false, syncFailed = false,
                    enabled = repository.enabled && repository.permissionStatus().canPost) }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) {
                syncJob = null
                _state.update { it.copy(syncing = false, syncFailed = true, enabled = false,
                    message = "Chưa đồng bộ được cài đặt thông báo với máy chủ. Hãy kiểm tra mạng và thử lại.") }
            }
        }
    }

    fun setEnabled(enabled: Boolean) {
        if (_state.value.busy || _state.value.confirmEnable || _state.value.syncing) return
        if (enabled) {
            refreshPermission()
            if (!_state.value.enabled) _state.update { it.copy(confirmEnable = true, message = null) }
        } else {
            repository.enabled = false
            repository.cancelNotifications()
            val status = repository.permissionStatus()
            _state.value = NotificationSettingsState(message = "Đã tắt thông báo trong ứng dụng.")
            // Only the user can turn off the Android setting immediately without ending the app process.
            if (status.runtimePermissionGranted && status.systemNotificationsEnabled) {
                launch(NotificationSettingsAction.DisableInSettings)
            }
            synchronizePreference()
        }
    }

    fun confirmEnable(canShowPermissionRationale: Boolean) {
        if (!_state.value.confirmEnable || _state.value.busy) return
        val status = repository.permissionStatus()
        _state.update { it.copy(confirmEnable = false) }
        when {
            status.canPost -> enableIfAllowed()
            status.runtimePermissionRequired && !status.runtimePermissionGranted &&
                (!repository.permissionRequested || canShowPermissionRationale) -> launch(NotificationSettingsAction.RequestPermission)
            else -> launch(NotificationSettingsAction.EnableInSettings)
        }
    }

    fun dismissConfirmation() { _state.update { it.copy(confirmEnable = false) } }

    fun openSystemSettings() {
        if (!_state.value.busy) launch(NotificationSettingsAction.ManageInSettings)
    }

    private fun launch(action: NotificationSettingsAction) {
        _state.update { it.copy(busy = true, action = action) }
    }

    // Consume before launching: recomposition or rotation must not launch the same system UI twice.
    fun consumeAction(): NotificationSettingsAction? {
        val action = _state.value.action ?: return null
        savedState[PENDING_ACTION] = action.name
        if (action == NotificationSettingsAction.RequestPermission) repository.permissionRequested = true
        _state.update { it.copy(action = null) }
        return action
    }

    fun onSystemUiResult() {
        val pending = savedState.remove<String>(PENDING_ACTION)
        if (pending == NotificationSettingsAction.RequestPermission.name || pending == NotificationSettingsAction.EnableInSettings.name) {
            enableIfAllowed()
        } else {
            refreshPermission()
            if (pending == NotificationSettingsAction.DisableInSettings.name) {
                _state.update { it.copy(message = if (repository.permissionStatus().canPost)
                    "Thông báo trong ứng dụng đã tắt. Quyền Android vẫn đang bật; bạn có thể tắt trong Cài đặt thông báo Android."
                else "Đã tắt thông báo và quyền hiển thị trên thiết bị.") }
            }
        }
        _state.update { it.copy(busy = false) }
    }

    fun onResume() {
        if (savedState.contains(PENDING_ACTION)) onSystemUiResult() else refreshPermission()
        synchronizePreference()
    }

    fun onLaunchFailed() {
        savedState.remove<String>(PENDING_ACTION)
        refreshPermission()
        _state.update { it.copy(busy = false, action = null,
            message = "Không mở được yêu cầu quyền. Hãy vào Cài đặt Android > Ứng dụng > English Battle > Thông báo.") }
    }

    private fun enableIfAllowed() {
        val allowed = repository.permissionStatus().canPost
        repository.enabled = allowed
        _state.update { it.copy(enabled = allowed, confirmEnable = false,
            message = if (allowed) "Đã bật thông báo." else "Chưa được cấp quyền. Thông báo vẫn đang tắt.") }
        synchronizePreference()
    }

    private fun refreshPermission() {
        val status = repository.permissionStatus()
        if (!status.canPost) repository.enabled = false
        _state.update { it.copy(enabled = repository.enabled && status.canPost && !repository.needsSynchronization,
            needsSystemSettings = !status.canPost && (!status.runtimePermissionRequired ||
                status.runtimePermissionGranted || repository.permissionRequested)) }
    }

    fun consumeLatestNotification(notifications: List<AppNotification>): String? {
        refreshPermission()
        val latest = notifications.filter { !it.read }.maxByOrNull { it.createdAt } ?: return null
        if (latest.createdAt <= repository.lastNotificationAt) return null
        // Muted notifications remain in the inbox, but are not replayed when the user enables alerts.
        repository.lastNotificationAt = latest.createdAt
        return latest.title.takeIf { _state.value.enabled }
    }

    private companion object { const val PENDING_ACTION = "notification-settings-pending-action" }
}
