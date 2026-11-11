package com.englishbattle.app.ui

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.englishbattle.app.EnglishBattleApplication
import com.englishbattle.app.data.*
import com.google.firebase.functions.FirebaseFunctionsException
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

data class AuthState(val user: UserIdentity? = null,
    val busy: Boolean = false, val initializing: Boolean = true, val error: String? = null, val message: String? = null)
class AuthViewModel(app: Application, private val repository: AuthRepository,
    private val synchronizeProfile: suspend () -> Unit,
    private val googleClient: GoogleAuthClient? = null) : AndroidViewModel(app) {
    constructor(app: Application) : this(app, (app as EnglishBattleApplication).container.auth,
        { app.container.game.ensureProfile() })
    private val _state = MutableStateFlow(AuthState())
    val state = _state.asStateFlow()
    private var latestFirebaseUser: UserIdentity? = null
    private val googleSignInClient by lazy { googleClient ?: GoogleSignInClient(app) }
    init {
        viewModelScope.launch { repository.users.collect { user ->
            latestFirebaseUser = user
            if (!(_state.value.busy && _state.value.user == null)) _state.update { it.copy(user = user, initializing = false) }
        } }
    }
    private fun action(block: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, error = null, message = null) }
        viewModelScope.launch {
            try { block() }
            catch (_: GetCredentialCancellationException) { /* The account picker was dismissed. */ }
            catch (e: Exception) { _state.update { it.copy(error = friendlyError(e)) } }
            finally { _state.update { it.copy(busy = false, user = latestFirebaseUser) } }
        }
    }
    fun submit(register: Boolean, name: String, email: String, password: String) = action {
        if (register) repository.signUp(name.trim(), email.trim(), password) else repository.signIn(email.trim(), password)
    }
    fun signInWithGoogle(activityContext: Context) = action {
        repository.signInWithGoogle(googleSignInClient.idToken(activityContext))
    }
    fun reset(email: String) = action {
        repository.resetPassword(email.trim())
        _state.update { it.copy(message = "Nếu email có tài khoản phù hợp, bạn sẽ nhận được liên kết đặt lại mật khẩu. Hãy kiểm tra cả thư rác.") }
    }
    fun updateName(name: String) = action {
        repository.updateName(name.trim())
        try { synchronizeProfile() }
        catch (error: Exception) {
            friendlyError(error) // Propagate cancellation before reporting a pending sync.
            throw UserFacingException("Tên đã được lưu nhưng chưa đồng bộ xong. Vui lòng thử lại khi có kết nối.")
        }
        _state.update { it.copy(message = "Đã cập nhật tên tài khoản.") }
    }
    fun changeEmail(email: String, password: String) = action {
        repository.changeEmail(email.trim(), password)
        _state.update { it.copy(message = "Đã gửi liên kết xác nhận đến email mới. Sau khi xác nhận, hãy đăng nhập lại bằng email mới.") }
    }
    fun refreshProfile() {
        if (_state.value.user == null) return
        action { repository.reloadUser(); synchronizeProfile() }
    }
    fun dismiss() { _state.update { it.copy(error = null, message = null) } }
    fun signOut() = action {
        repository.signOut()
        latestFirebaseUser = null
        _state.update { it.copy(user = null, initializing = false) }
        try {
            withTimeout(5000) { googleSignInClient.clearState() }
        } catch (_: ClearCredentialException) {
            Log.w("GoogleSignIn", "Credential provider state could not be cleared.")
        } catch (_: TimeoutCancellationException) {
            Log.w("GoogleSignIn", "Clearing credential provider state timed out.")
        }
    }
}

class CatalogViewModel(app: Application, private val catalogRepository: () -> CatalogRepository) : AndroidViewModel(app) {
    constructor(app: Application) : this(app, { (app as EnglishBattleApplication).container.catalog })
    private val _state = MutableStateFlow(LoadState<Catalog>())
    val state = _state.asStateFlow()
    private var job: Job? = null
    fun connect() { _state.value = LoadState(); retry() }
    fun clear() { job?.cancel(); _state.value = LoadState() }
    fun retry() {
        job?.cancel()
        _state.value = LoadState(loading = true)
        job = viewModelScope.launch {
            try {
                supervisorScope {
                    val stream = catalogRepository().observe().produceIn(this)
                    try {
                        _state.value = LoadState(data = withTimeout(15_000) { stream.receive() })
                        for (data in stream) _state.value = LoadState(data)
                    } finally { stream.cancel() }
                }
            } catch (e: Exception) { _state.value = LoadState(error = friendlyError(e)) }
        }
    }
}

class UserDataViewModel(app: Application, private val repository: GameRepository) : AndroidViewModel(app) {
    constructor(app: Application) : this(app, (app as EnglishBattleApplication).container.game)
    private var scope = CoroutineScope(viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext[Job]))
    private val _dashboard = MutableStateFlow(LoadState<Dashboard>())
    val dashboard = _dashboard.asStateFlow()
    private val _board = MutableStateFlow(LoadState<LeaderboardPage>())
    val board = _board.asStateFlow()
    private val _notifications = MutableStateFlow(LoadState<NotificationPage>())
    val notifications = _notifications.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()
    private var dashboardJob: Job? = null
    private var boardJob: Job? = null
    private var notificationsJob: Job? = null
    private var boardGeneration = 0
    private var notificationsGeneration = 0
    private var sessionGeneration = 0
    private var dashboardGeneration = 0
    var period = "week"; private set
    fun connect() {
        clear()
        scope = CoroutineScope(viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext[Job]))
        refresh(); loadBoard("week")
    }
    fun clear() { sessionGeneration++; dashboardGeneration++; boardGeneration++; notificationsGeneration++; scope.cancel(); _dashboard.value = LoadState(); _board.value = LoadState(); _notifications.value = LoadState(); _message.value = null }
    fun refresh() {
        val generation = ++dashboardGeneration
        dashboardJob?.cancel()
        _dashboard.update { it.copy(loading = true, error = null) }
        dashboardJob = scope.launch {
            try {
                val data = repository.dashboard()
                if (generation != dashboardGeneration) return@launch
                _dashboard.value = LoadState(data)
                _notifications.update { state -> state.copy(data = state.data?.copy(unreadCount = data.unreadNotificationCount)) }
            } catch (e: Exception) { val error = friendlyError(e); if (generation == dashboardGeneration) _dashboard.update { it.copy(loading = false, error = error) } }
        }
    }
    fun loadBoard(period: String, more: Boolean = false) {
        if (more && (_board.value.loading || period != this.period || _board.value.data?.nextCursor == null)) return
        val generation = ++boardGeneration
        boardJob?.cancel(); this.period = period
        val previous = if (more) _board.value.data else null
        _board.value = LoadState(previous, loading = true)
        boardJob = scope.launch {
            try {
                val page = repository.leaderboard(period, previous?.nextCursor)
                if (generation != boardGeneration) return@launch
                _board.value = LoadState(if (previous == null) page else page.copy(entries = (previous.entries + page.entries).distinctBy { it.uid }))
            } catch (e: Exception) { val error = friendlyError(e); if (generation == boardGeneration) _board.value = LoadState(previous, error = error) }
        }
    }
    fun loadNotifications(more: Boolean = false) {
        if (more && (_notifications.value.loading || _notifications.value.data?.nextCursor == null)) return
        val generation = ++notificationsGeneration
        notificationsJob?.cancel()
        val previous = if (more) _notifications.value.data else null
        _notifications.value = LoadState(previous, loading = true)
        notificationsJob = scope.launch {
            try {
                val page = repository.notifications(previous?.nextCursor)
                if (generation != notificationsGeneration) return@launch
                _notifications.value = LoadState(if (previous == null) page else page.copy(
                    entries = (previous.entries + page.entries).associateBy { it.id }.values.toList()))
            } catch (e: Exception) { val error = friendlyError(e); if (generation == notificationsGeneration) _notifications.value = LoadState(previous, error = error) }
        }
    }
    fun markRead(ids: List<String>) {
        if (ids.isEmpty()) return
        val generation = sessionGeneration
        scope.launch {
            try { repository.markRead(ids); if (generation == sessionGeneration) { updateReadState(ids.toSet()); refresh() } }
            catch (e: Exception) { val error = friendlyError(e); if (generation == sessionGeneration) _message.value = error }
        }
    }
    fun markAllRead() {
        val generation = sessionGeneration
        scope.launch {
            try { repository.markAllNotificationsRead(); if (generation == sessionGeneration) { updateReadState(null); refresh() } }
            catch (e: Exception) { val error = friendlyError(e); if (generation == sessionGeneration) _message.value = error }
        }
    }
    private fun updateReadState(ids: Set<String>?) {
        notificationsGeneration++; notificationsJob?.cancel()
        _notifications.update { state -> state.data?.let { page ->
            val changed = page.entries.count { !it.read && (ids == null || it.id in ids) }
            state.copy(loading = false, error = null, data = page.copy(entries = page.entries.map { if (ids == null || it.id in ids) it.copy(read = true) else it },
                unreadCount = if (ids == null) 0 else (page.unreadCount - changed).coerceAtLeast(0)))
        } ?: state }
    }
    fun dismiss() { _message.value = null }
}

class PlayViewModel(app: Application, private val repository: GameRepository) : AndroidViewModel(app) {
    constructor(app: Application) : this(app, (app as EnglishBattleApplication).container.game)
    private val container = (app as EnglishBattleApplication).container
    private val prefs = app.getSharedPreferences("english_battle_pending", Context.MODE_PRIVATE)
    private var scope = CoroutineScope(viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext[Job]))
    private var key = ""
    private var foreground = true
    private var generation = 0
    private val gate = Mutex()
    private var operation: Job? = null
    private var poll: Job? = null
    private var selectionJob: Job? = null
    private var selectionVersion = 0
    private var lastStart: Pair<QuizMode, String?>? = null
    private var lastFind: Pair<String, String?>? = null
    private val _attempt = MutableStateFlow(LoadState<AttemptState>())
    val attempt = _attempt.asStateFlow()
    private val _ticket = MutableStateFlow(LoadState<MatchTicket>())
    val ticket = _ticket.asStateFlow()
    private val _result = MutableStateFlow(LoadState<QuizResult>())
    val result = _result.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()
    val activeId get() = prefs.getString("active-$key", null)
    val hasPendingStart get() = prefs.contains("start-mode-$key")
    val hasPendingMatch get() = prefs.contains("ticket-$key") || prefs.contains("find-kind-$key")
    fun now() = container.clock.now(battle = _attempt.value.data?.mode == QuizMode.BATTLE)
    fun connect(uid: String) {
        clear(); key = "FIREBASE-$uid"
        scope = CoroutineScope(viewModelScope.coroutineContext + SupervisorJob(viewModelScope.coroutineContext[Job]))
        val pendingTicket = prefs.getString("ticket-$key", null)
        if (pendingTicket != null) {
            _ticket.value = LoadState(loading = true)
            run { acceptTicket(repository.matchStatus(pendingTicket)); beginPoll() }
        } else if (activeId != null || hasPendingStart) resume()
    }
    fun clear() {
        generation++
        scope.cancel(); _attempt.value = LoadState(); _ticket.value = LoadState(); _result.value = LoadState()
        _busy.value = false; _error.value = null
        lastStart = null; lastFind = null
    }
    private fun run(block: suspend () -> Unit) {
        if (_busy.value) return
        val sessionGeneration = generation
        val interruptPoll = _attempt.value.data?.mode?.let { it != QuizMode.BATTLE } == true
        if (interruptPoll) poll?.cancel()
        _busy.value = true; _error.value = null
        operation = scope.launch {
            try { gate.withLock { block() } } catch (e: Exception) { val message = friendlyError(e); if (sessionGeneration == generation) _error.value = message }
            finally {
                if (sessionGeneration == generation) {
                    _busy.value = false
                    _attempt.update { it.copy(loading = false) }
                    _ticket.update { it.copy(loading = false) }
                    if (interruptPoll && poll?.isActive != true) beginPoll()
                }
            }
        }
    }
    private fun acceptTicket(t: MatchTicket) {
        _ticket.value = LoadState(t)
        if (t.status in listOf("cancelled", "expired", "failed")) prefs.edit().remove("ticket-$key").apply()
    }
    private fun definitiveFailure(e: Exception) = e is FirebaseFunctionsException && e.code in listOf(
        FirebaseFunctionsException.Code.INVALID_ARGUMENT, FirebaseFunctionsException.Code.FAILED_PRECONDITION,
        FirebaseFunctionsException.Code.PERMISSION_DENIED, FirebaseFunctionsException.Code.NOT_FOUND,
        FirebaseFunctionsException.Code.UNIMPLEMENTED, FirebaseFunctionsException.Code.ALREADY_EXISTS)
    private fun accept(a: AttemptState) {
        _attempt.value = LoadState(a)
        if (a.status == "active" || a.status == "waiting") prefs.edit().putString("active-$key", a.id).apply()
        else prefs.edit().remove("active-$key").apply()
        a.result?.let { _result.value = LoadState(it) }
        beginPoll()
    }
    fun start(quizMode: QuizMode, topicId: String? = null) = run {
        _attempt.value = LoadState(loading = true)
        _result.value = LoadState()
        if (activeId != null) throw UserFacingException("Bạn có bài hoặc trận đang dở. Hãy tiếp tục hoặc kết thúc phiên đó trước.")
        if (hasPendingMatch) throw UserFacingException("Bạn đang có yêu cầu tìm trận. Hãy mở lại yêu cầu đó trước.")
        val pendingMode = prefs.getString("start-mode-$key", null)
        if (pendingMode != null && (quizMode.name != pendingMode || topicId != prefs.getString("start-topic-$key", null)))
            throw UserFacingException("Bạn có yêu cầu bắt đầu bài đang chờ. Hãy tiếp tục yêu cầu đó trước.")
        lastStart = quizMode to topicId
        val signature = "${quizMode.name}-${topicId.orEmpty()}"
        val requestId = prefs.getString("start-$key-$signature", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("start-$key-$signature", it).apply()
        }
        prefs.edit().putString("start-mode-$key", quizMode.name).putString("start-topic-$key", topicId).apply()
        try {
            accept(repository.start(quizMode, topicId, requestId))
            prefs.edit().remove("start-$key-$signature").remove("start-mode-$key").remove("start-topic-$key").apply()
        } catch (e: Exception) {
            if (definitiveFailure(e)) prefs.edit().remove("start-$key-$signature").remove("start-mode-$key").remove("start-topic-$key").apply()
            throw e
        }
    }
    fun resume(id: String? = activeId) {
        if (id == null) {
            val pendingMode = prefs.getString("start-mode-$key", null)
            val request = pendingMode?.let { QuizMode.valueOf(it) to prefs.getString("start-topic-$key", null) } ?: lastStart ?: return
            start(request.first, request.second); return
        }
        run { accept(repository.resume(id)) }
    }
    fun submit(optionId: String?) = run {
        val a = _attempt.value.data ?: return@run
        val q = a.current ?: return@run
        if (a.receipt != null || a.status != "active") return@run
        // Explicit answers carry their own option. Only timeouts and battles
        // depend on the acknowledgement of the saved selection.
        if (optionId == null || a.mode == QuizMode.BATTLE) selectionJob?.join()
        accept(repository.submit(a.id, q.id, optionId, "answer-${a.id}-${q.id}"))
    }
    fun saveSelection(optionId: String) {
        val a = _attempt.value.data ?: return
        val q = a.current ?: return
        if (a.receipt != null || a.status != "active") return
        val previous = selectionJob
        val version = ++selectionVersion
        selectionJob = scope.launch {
            previous?.join()
            if (version != selectionVersion) return@launch
            try {
                repository.saveSelection(a.id, q.id, optionId, UUID.randomUUID().toString())
                val current = _attempt.value.data
                if (version == selectionVersion && !_busy.value && current?.current?.id == q.id && current.receipt == null)
                    _error.value = null
            } catch (e: Exception) {
                currentCoroutineContext().ensureActive()
                val current = _attempt.value.data
                if (version == selectionVersion && !_busy.value && current?.current?.id == q.id && current.receipt == null)
                    _error.value = "Chưa lưu được lựa chọn. Kiểm tra kết nối và thử lại."
            }
        }
    }
    fun advance() = run {
        val a = _attempt.value.data ?: return@run
        val next = if (a.mode != QuizMode.BATTLE && a.status == "waiting" && a.receipt != null)
            completeWaitingAttempt(a, repository::historyDetail)
        else repository.advance(a.id, "advance-${a.id}-${a.index}", a.index)
        accept(next)
    }
    fun leave() = run {
        val a = _attempt.value.data ?: return@run
        accept(repository.leave(a.id, "leave-${a.id}"))
    }
    fun find(kind: String, code: String? = null) = run {
        if (activeId != null || hasPendingStart || prefs.contains("ticket-$key")) throw UserFacingException("Bạn đang có phiên hoặc yêu cầu tìm trận. Hãy mở lại phiên đó.")
        val pendingKind = prefs.getString("find-kind-$key", null)
        if (pendingKind != null && (kind != pendingKind || code != prefs.getString("find-code-$key", null))) throw UserFacingException("Hãy mở lại yêu cầu tìm trận đang chờ trước.")
        _attempt.value = LoadState(); _result.value = LoadState()
        lastFind = kind to code
        val signature = "$kind-${code.orEmpty()}"
        val request = prefs.getString("find-$key-$signature", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("find-$key-$signature", it).apply() }
        prefs.edit().putString("find-kind-$key", kind).putString("find-code-$key", code).apply()
        _ticket.value = LoadState(loading = true)
        try {
            val t = repository.findMatch(kind, code, request)
            prefs.edit().putString("ticket-$key", t.id).remove("find-$key-$signature").remove("find-kind-$key").remove("find-code-$key").apply()
            acceptTicket(t); beginPoll()
        } catch (e: Exception) {
            if (definitiveFailure(e)) prefs.edit().remove("find-$key-$signature").remove("find-kind-$key").remove("find-code-$key").apply()
            throw e
        }
    }
    fun retryMatch() {
        val id = _ticket.value.data?.id ?: prefs.getString("ticket-$key", null)
        if (id == null) {
            val kind = prefs.getString("find-kind-$key", null)
            val request = kind?.let { it to prefs.getString("find-code-$key", null) } ?: lastFind ?: return
            find(request.first, request.second); return
        }
        run { acceptTicket(repository.matchStatus(id)); beginPoll() }
    }
    fun enterMatch() = run {
        val t = _ticket.value.data ?: return@run
        val id = t.attemptId ?: return@run
        accept(repository.resume(id))
        prefs.edit().remove("ticket-$key").apply(); _ticket.value = LoadState()
    }
    fun cancelMatch() = run {
        var id = _ticket.value.data?.id ?: prefs.getString("ticket-$key", null)
        if (id == null) {
            val kind = prefs.getString("find-kind-$key", null) ?: return@run
            val code = prefs.getString("find-code-$key", null)
            val signature = "$kind-${code.orEmpty()}"
            val request = prefs.getString("find-$key-$signature", null) ?: return@run
            val t = repository.findMatch(kind, code, request)
            prefs.edit().putString("ticket-$key", t.id).remove("find-kind-$key").remove("find-code-$key").remove("find-$key-$signature").apply()
            id = t.id
        }
        val cancelled = repository.cancelMatch(id)
        prefs.edit().remove("ticket-$key").apply(); _ticket.value = LoadState(); poll?.cancel()
        // A matched cancellation enters the leave window and still needs polling.
        cancelled?.let(::accept)
    }
    fun viewResult(id: String) = run {
        _result.value = LoadState(loading = true)
        try { _result.value = LoadState(repository.historyDetail(id)) }
        catch (e: Exception) { _result.value = LoadState(error = friendlyError(e)) }
    }
    fun setForeground(value: Boolean) { foreground = value; if (!value) poll?.cancel() else { if (activeId != null) resume(); beginPoll() } }
    private fun beginPoll() {
        poll?.cancel()
        if (!foreground) return
        val matching = _ticket.value.data?.status in listOf("searching", "waiting")
        val a = _attempt.value.data
        val playing = a?.status == "active" ||
            (a?.status == "waiting" && (a.mode == QuizMode.BATTLE || a.receipt == null))
        if (!matching && !playing) return
        val interval = if (matching) 1000L else 3000L
        poll = scope.launch {
            while (isActive) {
                delay(interval)
                if (_busy.value) continue
                try {
                    gate.withLock {
                    if (_busy.value) return@withLock
                    if (matching) {
                        val t = repository.matchStatus(_ticket.value.data!!.id)
                        acceptTicket(t)
                    } else {
                        val a = repository.resume(_attempt.value.data!!.id)
                        _attempt.value = LoadState(a)
                        if (a.result != null) accept(a)
                    }
                    _error.value = null
                    }
                    if (matching && _ticket.value.data?.status !in listOf("searching", "waiting")) break
                    if (!matching && _attempt.value.data?.result != null) break
                } catch (e: Exception) {
                    currentCoroutineContext().ensureActive()
                    _error.value = friendlyError(e)
                    delay(if (matching) 1000L else 7000L)
                }
            }
        }
    }
    fun dismiss() { _error.value = null }
}

fun connectionFlow(context: Context): Flow<Boolean> = callbackFlow {
    val cm = context.getSystemService(ConnectivityManager::class.java)
    fun connected() = cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { trySend(connected()) }
        override fun onLost(network: Network) { trySend(connected()) }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) { trySend(connected()) }
    }
    cm.registerDefaultNetworkCallback(callback); trySend(connected())
    awaitClose { cm.unregisterNetworkCallback(callback) }
}.distinctUntilChanged()
