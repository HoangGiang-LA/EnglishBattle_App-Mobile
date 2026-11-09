package com.englishbattle.app.data

import com.englishbattle.app.BuildConfig
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.*
import com.google.firebase.database.*
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeout
import org.json.JSONObject

class FirebaseAuthRepository(private val auth: FirebaseAuth = FirebaseAuth.getInstance()) : AuthRepository {
    private val profileUpdates = MutableStateFlow(0)
    private fun identity() = auth.currentUser?.let {
        UserIdentity(it.uid, it.displayName?.takeIf(String::isNotBlank) ?: "Người học", it.email.orEmpty(), it.metadata?.creationTimestamp ?: 0)
    }
    private val authUsers: Flow<UserIdentity?> = callbackFlow {
        val listener = FirebaseAuth.AuthStateListener { trySend(identity()) }
        auth.addAuthStateListener(listener)
        awaitClose { auth.removeAuthStateListener(listener) }
    }
    override val users: Flow<UserIdentity?> = combine(authUsers, profileUpdates) { _, _ -> identity() }.distinctUntilChanged()
    override suspend fun signIn(email: String, password: String) { withTimeout(20_000) { auth.signInWithEmailAndPassword(email, password).await() } }
    override suspend fun signUp(name: String, email: String, password: String) {
        if (!PasswordPolicy.isValid(password)) throw UserFacingException(PasswordPolicy.MESSAGE)
        withTimeout(20_000) {
            val user = auth.createUserWithEmailAndPassword(email, password).await().user ?: throw UserFacingException("Không tạo được tài khoản. Vui lòng thử lại.")
            // The account exists even if the optional name update fails. Auth state still owns the session.
            user.updateProfile(UserProfileChangeRequest.Builder().setDisplayName(name).build()).await()
            profileUpdates.value++
        }
    }
    override suspend fun resetPassword(email: String) { withTimeout(20_000) { auth.sendPasswordResetEmail(email).await() } }
    override suspend fun updateName(name: String) {
        withTimeout(20_000) {
            (auth.currentUser ?: throw UserFacingException("Vui lòng đăng nhập lại.")).updateProfile(
                UserProfileChangeRequest.Builder().setDisplayName(name).build()).await()
            profileUpdates.value++
        }
    }
    override suspend fun changeEmail(email: String, currentPassword: String) {
        withTimeout(20_000) {
            val user = auth.currentUser ?: throw UserFacingException("Vui lòng đăng nhập lại.")
            user.reauthenticate(EmailAuthProvider.getCredential(user.email.orEmpty(), currentPassword)).await()
            user.verifyBeforeUpdateEmail(email).await()
        }
    }
    override suspend fun reloadUser() {
        withTimeout(20_000) {
            try { auth.currentUser?.reload()?.await() }
            catch (error: FirebaseAuthInvalidUserException) { auth.signOut(); throw error }
            profileUpdates.value++
        }
    }
    override fun signOut() = auth.signOut()
}

class FirebaseCatalogRepository(private val db: FirebaseDatabase) : CatalogRepository {
    private fun values(path: String): Flow<DataSnapshot> = callbackFlow {
        val ref = db.getReference(path).orderByChild("status").equalTo("published")
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { trySend(snapshot) }
            override fun onCancelled(error: DatabaseError) { close(UserFacingException(if (error.code == DatabaseError.PERMISSION_DENIED)
                "Tài khoản chưa được cấp quyền xem nội dung. Vui lòng thử lại sau." else "Không tải được nội dung. Kiểm tra kết nối và thử lại.")) }
        }
        ref.addValueEventListener(listener)
        awaitClose { ref.removeEventListener(listener) }
    }
    override fun observe(): Flow<Catalog> = combine(values("categories"), values("topics")) { categories, topics ->
        val publishedCategories = categories.children.filter {
            it.key in listOf("vocabulary", "grammar", "listening", "reading") &&
                it.child("status").getValue(String::class.java) == "published"
        }.mapNotNull {
            val name = it.child("name").getValue(String::class.java) ?: return@mapNotNull null
            Category(it.key ?: return@mapNotNull null, name, it.child("sortOrder").getValue(Int::class.java) ?: 0)
        }.sortedBy { it.order }
        val categoryIds = publishedCategories.map { it.id }.toSet()
        Catalog(publishedCategories, topics.children.filter {
            it.child("status").getValue(String::class.java) == "published" &&
                it.child("categoryId").getValue(String::class.java) in categoryIds
        }.mapNotNull {
            Topic(it.key ?: return@mapNotNull null, it.child("categoryId").getValue(String::class.java) ?: return@mapNotNull null,
                it.child("title").getValue(String::class.java) ?: return@mapNotNull null,
                it.child("sortOrder").getValue(Int::class.java) ?: 0,
                it.child("completionTarget").getValue(Int::class.java) ?: GameRules.PRACTICE_TARGET)
        }.sortedBy { it.order })
    }
}

class ServerClock {
    private var offset = 0L
    private var battleOffset: Long? = null
    fun synchronize(serverNow: Long, sentAt: Long, receivedAt: Long) { offset = serverNow - (sentAt + (receivedAt - sentAt) / 2) }
    // Battle responses use database time even when a local Functions host has a skewed clock.
    fun synchronizeBattle(serverNow: Long) { battleOffset = serverNow - System.nanoTime() / 1_000_000L }
    fun now(battle: Boolean = false): Long {
        if (battle) battleOffset?.let { return it + System.nanoTime() / 1_000_000L }
        return System.currentTimeMillis() + offset
    }
}

class FirebaseGameRepository(private val clock: ServerClock,
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("asia-southeast1").apply {
        if (BuildConfig.USE_FUNCTIONS_EMULATOR) useEmulator("10.0.2.2", 5001)
    }, private val auth: FirebaseAuth = FirebaseAuth.getInstance()) : GameRepository {
    private val clientSessionId by lazy {
        val prefs = com.google.firebase.FirebaseApp.getInstance().applicationContext
            .getSharedPreferences("english_battle_device", android.content.Context.MODE_PRIVATE)
        prefs.getString("battle-session", null) ?: java.util.UUID.randomUUID().toString().also {
            prefs.edit().putString("battle-session", it).apply()
        }
    }
    private fun callableTimeoutMs(name: String): Long = when (name) {
        "getStudyStatistics" -> 120_000L
        "ensureUserProfile" -> 60_000L
        else -> 20_000L
    }
    private suspend fun call(name: String, data: Map<String, Any?> = emptyMap()): JSONObject = withTimeout(callableTimeoutMs(name)) {
        val sentAt = System.currentTimeMillis()
        val request = if (name in setOf("findBattle", "getBattleTicket", "cancelBattleSearch", "resumeAttempt",
                "submitAttemptAnswer", "saveAttemptSelection", "advanceAttempt", "leaveAttempt", "getAttemptResult"))
            data + ("clientSessionId" to clientSessionId) else data
        val response = try {
            val callable = functions.getHttpsCallable(name)
            if (name in setOf("getStudyStatistics", "ensureUserProfile"))
                callable.setTimeout(callableTimeoutMs(name), java.util.concurrent.TimeUnit.MILLISECONDS)
            callable.call(request).await().data
        }
        catch (e: FirebaseFunctionsException) {
            if (e.code == FirebaseFunctionsException.Code.UNAUTHENTICATED) auth.signOut()
            throw e
        }
        val raw = response as? Map<*, *>
            ?: throw UserFacingException("Dịch vụ trả về dữ liệu không hợp lệ. Vui lòng thử lại.")
        val json = JSONObject(raw)
        if (json.has("serverNow")) {
            val serverNow = json.getLong("serverNow")
            val battle = name in setOf("findBattle", "getBattleTicket", "cancelBattleSearch") ||
                (data["attemptId"] as? String)?.startsWith("battle_") == true
            if (battle) clock.synchronizeBattle(serverNow)
            else clock.synchronize(serverNow, sentAt, System.currentTimeMillis())
        }
        json
    }
    private suspend fun attempt(response: JSONObject): AttemptState = completeWaitingAttempt(
        WireCodec.attempt(response.getJSONObject("attempt")), ::historyDetail
    )
    override suspend fun ensureProfile() { call("ensureUserProfile") }
    override suspend fun dashboard() = WireCodec.dashboard(call("getUserDashboard").getJSONObject("dashboard"))
    override suspend fun statistics(period: String) = WireCodec.statistics(call("getStudyStatistics", mapOf("period" to period)).getJSONObject("statistics"))
    override suspend fun history(kind: String, cursor: String?) = WireCodec.historyPage(call("getHistory", mapOf("kind" to kind, "cursor" to cursor)).getJSONObject("page"))
    override suspend fun coinLedger(cursor: String?) = WireCodec.ledgerPage(call("getCoinLedger", mapOf("cursor" to cursor)).getJSONObject("page"))
    override suspend fun start(mode: QuizMode, topicId: String?, requestId: String) = attempt(call("startAttempt",
        mapOf("mode" to mode.name, "topicId" to topicId, "requestId" to requestId)))
    override suspend fun resume(attemptId: String) = attempt(call("resumeAttempt", mapOf("attemptId" to attemptId)))
    override suspend fun submit(attemptId: String, questionId: String, optionId: String?, requestId: String) = attempt(call("submitAttemptAnswer",
        mapOf("attemptId" to attemptId, "questionId" to questionId, "optionId" to optionId, "requestId" to requestId)))
    override suspend fun saveSelection(attemptId: String, questionId: String, optionId: String, requestId: String) {
        call("saveAttemptSelection", mapOf("attemptId" to attemptId, "questionId" to questionId,
            "optionId" to optionId, "requestId" to requestId))
    }
    override suspend fun advance(attemptId: String, requestId: String, expectedIndex: Int?) = attempt(call("advanceAttempt",
        mapOf("attemptId" to attemptId, "requestId" to requestId) +
            (expectedIndex?.let { mapOf("expectedIndex" to it) } ?: emptyMap())))
    override suspend fun leave(attemptId: String, requestId: String) = attempt(call("leaveAttempt",
        mapOf("attemptId" to attemptId, "requestId" to requestId)))
    override suspend fun findMatch(kind: String, code: String?, requestId: String) = WireCodec.ticket(call("findBattle",
        mapOf("kind" to kind, "roomCode" to code, "requestId" to requestId)).getJSONObject("ticket"))
    override suspend fun matchStatus(ticketId: String) = WireCodec.ticket(call("getBattleTicket", mapOf("ticketId" to ticketId)).getJSONObject("ticket"))
    override suspend fun cancelMatch(ticketId: String): AttemptState? {
        val response = call("cancelBattleSearch", mapOf("ticketId" to ticketId))
        return response.optJSONObject("attempt")?.let(WireCodec::attempt)
    }
    override suspend fun leaderboard(period: String, cursor: String?) = WireCodec.leaderboard(call("getLeaderboard", mapOf("period" to period, "cursor" to cursor)).getJSONObject("page"))
    override suspend fun notifications(cursor: String?) = WireCodec.notifications(call("getNotifications", mapOf("cursor" to cursor)).getJSONObject("page"))
    override suspend fun markAllNotificationsRead() { call("markNotificationsRead", mapOf("all" to true)) }
    override suspend fun markRead(ids: List<String>) {
        ids.distinct().chunked(50).forEach { call("markNotificationsRead", mapOf("ids" to it)) }
    }
    override suspend fun historyDetail(attemptId: String) = WireCodec.result(call("getAttemptResult", mapOf("attemptId" to attemptId)).getJSONObject("result"))
}

fun friendlyError(error: Throwable): String {
    if (error is CancellationException && error !is TimeoutCancellationException) throw error
    return when (error) {
        is UserFacingException -> error.message.orEmpty()
        is FirebaseNetworkException, is TimeoutCancellationException -> "Kết nối bị gián đoạn hoặc phản hồi quá lâu. Kiểm tra mạng và thử lại."
        is FirebaseTooManyRequestsException -> "Bạn thao tác quá nhiều lần. Vui lòng đợi một lúc rồi thử lại."
        is FirebaseAuthWeakPasswordException -> PasswordPolicy.MESSAGE
        is FirebaseAuthUserCollisionException -> "Email đã được sử dụng. Hãy đăng nhập hoặc đặt lại mật khẩu."
        is FirebaseAuthInvalidCredentialsException, is FirebaseAuthInvalidUserException -> "Email hoặc mật khẩu không đúng, hoặc tài khoản không còn khả dụng."
        is FirebaseAuthException -> when (error.errorCode) {
            "ERROR_PASSWORD_DOES_NOT_MEET_REQUIREMENTS", "ERROR_WEAK_PASSWORD" -> PasswordPolicy.MESSAGE
            "ERROR_OPERATION_NOT_ALLOWED" -> "Phương thức đăng nhập này chưa được bật. Vui lòng thử lại sau."
            "ERROR_REQUIRES_RECENT_LOGIN" -> "Vui lòng đăng nhập lại để thực hiện thay đổi này."
            else -> "Không hoàn tất được xác thực. Vui lòng kiểm tra thông tin và thử lại."
        }
        is FirebaseFunctionsException -> when (error.code) {
            FirebaseFunctionsException.Code.UNAUTHENTICATED -> "Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại."
            FirebaseFunctionsException.Code.NOT_FOUND, FirebaseFunctionsException.Code.UNIMPLEMENTED -> "Tính năng này chưa sẵn sàng. Vui lòng quay lại sau."
            FirebaseFunctionsException.Code.PERMISSION_DENIED -> "Tài khoản chưa được cấp quyền thực hiện thao tác này."
            FirebaseFunctionsException.Code.FAILED_PRECONDITION, FirebaseFunctionsException.Code.ALREADY_EXISTS -> "Phiên hoặc lượt chơi đã thay đổi. Hãy tải lại trạng thái để tiếp tục."
            FirebaseFunctionsException.Code.UNAVAILABLE, FirebaseFunctionsException.Code.DEADLINE_EXCEEDED -> "Dịch vụ đang gián đoạn. Vui lòng thử lại."
            else -> "Không hoàn tất được thao tác. Vui lòng tải lại trạng thái trước khi thử lại."
        }
        else -> "Không tải được dữ liệu. Vui lòng thử lại."
    }
}
