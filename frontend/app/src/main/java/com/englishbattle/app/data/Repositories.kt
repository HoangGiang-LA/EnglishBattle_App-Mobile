package com.englishbattle.app.data

import kotlinx.coroutines.flow.Flow

interface AuthRepository {
    val users: Flow<UserIdentity?>
    suspend fun signIn(email: String, password: String)
    suspend fun signInWithGoogle(idToken: String)
    suspend fun signUp(name: String, email: String, password: String)
    suspend fun resetPassword(email: String)
    suspend fun updateName(name: String)
    suspend fun changeEmail(email: String, currentPassword: String)
    suspend fun reloadUser()
    fun signOut()
}
interface CatalogRepository { fun observe(): Flow<Catalog> }
interface GameRepository {
    suspend fun setNotificationPreference(enabled: Boolean, accountUid: String) { error("Notification preferences are unavailable") }
    suspend fun dashboard(): Dashboard
    suspend fun statistics(period: String): StudyStatistics
    suspend fun history(kind: String, cursor: String?): HistoryPage
    suspend fun coinLedger(cursor: String?): LedgerPage
    suspend fun ensureProfile()
    suspend fun start(mode: QuizMode, topicId: String?, requestId: String): AttemptState
    suspend fun resume(attemptId: String): AttemptState
    suspend fun submit(attemptId: String, questionId: String, optionId: String?, requestId: String): AttemptState
    suspend fun saveSelection(attemptId: String, questionId: String, optionId: String, requestId: String)
    suspend fun advance(attemptId: String, requestId: String, expectedIndex: Int? = null): AttemptState
    suspend fun leave(attemptId: String, requestId: String): AttemptState
    suspend fun findMatch(kind: String, code: String?, requestId: String): MatchTicket
    suspend fun matchStatus(ticketId: String): MatchTicket
    suspend fun cancelMatch(ticketId: String): AttemptState?
    suspend fun leaderboard(period: String, cursor: String?): LeaderboardPage
    suspend fun notifications(cursor: String?): NotificationPage
    suspend fun markAllNotificationsRead()
    suspend fun markRead(ids: List<String>)
    suspend fun historyDetail(attemptId: String): QuizResult
}
