package com.englishbattle.app

import android.app.Application
import android.content.Context
import androidx.credentials.exceptions.ClearCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import com.englishbattle.app.data.AuthRepository
import com.englishbattle.app.data.GoogleAuthClient
import com.englishbattle.app.data.UserIdentity
import com.englishbattle.app.ui.AuthViewModel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** No real Google account, Firebase session or credential provider is modified. */
class GoogleSignInTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val store = ViewModelStore()
    private val repository = FakeAuth()
    private val google = FakeGoogle()
    private lateinit var model: AuthViewModel

    private suspend fun connect() {
        instrumentation.runOnMainSync {
            model = AuthViewModel(instrumentation.targetContext.applicationContext as Application,
                repository, {}, google)
            store.put("google-sign-in", model)
        }
        withTimeout(5_000) { model.state.first { !it.initializing } }
    }

    private fun signIn() = instrumentation.runOnMainSync {
        model.signInWithGoogle(instrumentation.targetContext)
    }

    @After fun cleanUp() { instrumentation.runOnMainSync { store.clear() } }

    @Test fun selectedGoogleCredentialCreatesTheFirebaseSession() = runBlocking {
        connect()
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && it.user?.uid == "google-user" } }
        assertEquals(listOf("test-only-google-token"), repository.tokens)
        assertNull(model.state.value.error)
    }

    @Test fun closingTheAccountPickerIsSilentAndAllowsRetry() = runBlocking {
        google.failure = GetCredentialCancellationException()
        connect()
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && google.requests == 1 } }
        assertNull(model.state.value.error)
        assertTrue(repository.tokens.isEmpty())
        google.failure = null
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && it.user != null } }
        assertEquals(2, google.requests)
    }

    @Test fun missingGoogleAccountShowsAnActionableError() = runBlocking {
        google.failure = NoCredentialException()
        connect()
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && it.error != null } }
        assertTrue(model.state.value.error!!.contains("thêm tài khoản Google"))
        assertTrue(repository.tokens.isEmpty())
    }

    @Test fun repeatedTapsDoNotOpenMultipleAccountPickers() = runBlocking {
        google.gate = CompletableDeferred()
        connect()
        signIn()
        signIn()
        assertEquals(1, google.requests)
        assertTrue(model.state.value.busy)
        google.gate!!.complete(Unit)
        withTimeout(5_000) { model.state.first { !it.busy && it.user != null } }
        assertEquals(1, repository.tokens.size)
    }

    @Test fun firebaseFailureStaysOnLoginAndAllowsAnotherAttempt() = runBlocking {
        repository.failure = IllegalStateException("Test-only failure")
        connect()
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && it.error != null } }
        assertNull(model.state.value.user)
        repository.failure = null
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && it.user != null } }
        assertNull(model.state.value.error)
    }

    @Test fun signOutClearsFirebaseAndCredentialStateEvenIfTheProviderFails() = runBlocking {
        connect()
        signIn()
        withTimeout(5_000) { model.state.first { !it.busy && it.user != null } }
        google.clearFailure = ClearCredentialUnknownException()
        instrumentation.runOnMainSync { model.signOut() }
        withTimeout(5_000) { model.state.first { !it.busy && it.user == null } }
        assertEquals(1, google.clears)
        assertNull(repository.users.value)
        assertNull(model.state.value.error)
    }

    private class FakeGoogle : GoogleAuthClient {
        var requests = 0
        var clears = 0
        var failure: Exception? = null
        var clearFailure: Exception? = null
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun idToken(activityContext: Context): String {
            requests++
            gate?.await()
            failure?.let { throw it }
            return "test-only-google-token"
        }
        override suspend fun clearState() { clears++; clearFailure?.let { throw it } }
    }

    private class FakeAuth : AuthRepository {
        override val users = MutableStateFlow<UserIdentity?>(null)
        val tokens = mutableListOf<String>()
        var failure: Exception? = null
        override suspend fun signInWithGoogle(idToken: String) {
            tokens += idToken
            failure?.let { throw it }
            users.value = UserIdentity("google-user", "Google learner", "learner@example.test", 1)
        }
        override fun signOut() { users.value = null }
        override suspend fun signIn(email: String, password: String) = error("Unused")
        override suspend fun signUp(name: String, email: String, password: String) = error("Unused")
        override suspend fun resetPassword(email: String) = error("Unused")
        override suspend fun updateName(name: String) = error("Unused")
        override suspend fun changeEmail(email: String, currentPassword: String) = error("Unused")
        override suspend fun reloadUser() = Unit
    }
}
