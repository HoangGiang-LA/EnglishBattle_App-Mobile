package com.englishbattle.app

import android.app.Application
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import com.englishbattle.app.data.AuthRepository
import com.englishbattle.app.data.UserIdentity
import com.englishbattle.app.ui.AuthViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Profile sync tests use a fake Auth session and never touch the signed-in user. */
class ProfileSyncViewModelTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val store = ViewModelStore()
    private val repository = ProfileAuth()
    private lateinit var viewModel: AuthViewModel

    private suspend fun connect(sync: suspend () -> Unit) {
        instrumentation.runOnMainSync {
            viewModel = AuthViewModel(instrumentation.targetContext.applicationContext as Application, repository, sync)
            store.put("profile-sync", viewModel)
        }
        withTimeout(5_000) { viewModel.state.first { !it.initializing } }
    }

    @After fun cleanUp() { instrumentation.runOnMainSync { store.clear() } }

    @Test fun savedAuthNameIsRetriedWhenTheDatabaseSyncFails() = runBlocking {
        var syncs = 0
        connect { if (++syncs == 1) throw IOException("Offline") }
        instrumentation.runOnMainSync { viewModel.updateName("Updated name") }
        withTimeout(5_000) { viewModel.state.first { !it.busy && it.error != null && it.user?.name == "Updated name" } }
        assertEquals(1, syncs)
        assertEquals(1, repository.nameUpdates)
        instrumentation.runOnMainSync { viewModel.refreshProfile() }
        withTimeout(5_000) { viewModel.state.first { !it.busy && it.error == null && syncs == 2 } }
        assertEquals(1, repository.nameUpdates)
        assertEquals("Updated name", viewModel.state.value.user?.name)
    }

    @Test fun pendingEmailIsNotAppliedBeforeConfirmationAndReloadPrecedesSync() = runBlocking {
        val syncedEmails = mutableListOf<String>()
        connect { syncedEmails.add(repository.users.value!!.email) }
        instrumentation.runOnMainSync { viewModel.changeEmail("confirmed@example.test", "test-only") }
        withTimeout(5_000) { viewModel.state.first { !it.busy && it.message != null } }
        assertEquals("old@example.test", viewModel.state.value.user?.email)
        assertTrue(syncedEmails.isEmpty())
        instrumentation.runOnMainSync { viewModel.refreshProfile() }
        withTimeout(5_000) { viewModel.state.first { !it.busy && syncedEmails.size == 1 } }
        assertEquals(listOf("old@example.test"), syncedEmails)
        repository.confirmed = true
        instrumentation.runOnMainSync { viewModel.refreshProfile() }
        withTimeout(5_000) { viewModel.state.first { !it.busy && it.user?.email == "confirmed@example.test" } }
        assertEquals(listOf("old@example.test", "confirmed@example.test"), syncedEmails)
    }

    @Test fun successfulNameUpdateWaitsForSyncBeforeReportingSuccess() = runBlocking {
        var savedName: String? = null
        connect { savedName = repository.users.value?.name }
        instrumentation.runOnMainSync { viewModel.updateName(" New name ") }
        withTimeout(5_000) { viewModel.state.first { !it.busy && it.message != null } }
        assertEquals("New name", savedName)
        assertNull(viewModel.state.value.error)
    }

    private class ProfileAuth : AuthRepository {
        override val users = MutableStateFlow<UserIdentity?>(UserIdentity("isolated-profile", "Original", "old@example.test", 1))
        var confirmed = false
        var nameUpdates = 0
        private var pendingEmail: String? = null
        override suspend fun updateName(name: String) { nameUpdates++; users.value = users.value?.copy(name = name) }
        override suspend fun changeEmail(email: String, currentPassword: String) { pendingEmail = email }
        override suspend fun reloadUser() {
            if (confirmed) pendingEmail?.let { users.value = users.value?.copy(email = it) }
        }
        override suspend fun signIn(email: String, password: String) = error("Unused")
        override suspend fun signInWithGoogle(idToken: String) = error("Unused")
        override suspend fun signUp(name: String, email: String, password: String) = error("Unused")
        override suspend fun resetPassword(email: String) = error("Unused")
        override fun signOut() { users.value = null }
    }
}
