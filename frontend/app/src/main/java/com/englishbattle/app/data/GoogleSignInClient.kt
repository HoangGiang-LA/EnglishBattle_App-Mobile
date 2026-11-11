package com.englishbattle.app.data

import android.content.Context
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import com.englishbattle.app.R
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

interface GoogleAuthClient {
    suspend fun idToken(activityContext: Context): String
    suspend fun clearState()
}

class GoogleSignInClient(context: Context) : GoogleAuthClient {
    private val credentialManager = CredentialManager.create(context.applicationContext)

    override suspend fun idToken(activityContext: Context): String {
        val option = GetSignInWithGoogleOption.Builder(
            activityContext.getString(R.string.default_web_client_id)
        ).build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        val credential = credentialManager.getCredential(activityContext, request).credential
        if (credential !is CustomCredential ||
            credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            throw UserFacingException("Google trả về thông tin đăng nhập không hợp lệ. Vui lòng thử lại.")
        }
        return GoogleIdTokenCredential.createFrom(credential.data).idToken
    }

    override suspend fun clearState() {
        credentialManager.clearCredentialState(ClearCredentialStateRequest())
    }
}
