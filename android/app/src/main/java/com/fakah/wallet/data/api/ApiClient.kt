// ApiClient.kt — Fakah data layer: Retrofit service + OkHttp client (pinned) + DTOs
package com.fakah.wallet.data.api

import android.content.Context
import com.fakah.wallet.BuildConfig
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import com.google.gson.reflect.TypeToken
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLPeerUnverifiedException

// ═══════════════ DTOs ═══════════════

data class ApiError(
    val code: String? = null,
    val message: String? = null,
    val httpStatus: Int? = null,
)

data class Envelope<T>(
    val success: Boolean,
    val data: T? = null,
    val error: ApiError? = null,
) {
    companion object {
        fun <T> failed(code: String, message: String? = null): Envelope<T> =
            Envelope(success = false, error = ApiError(code, message ?: code))
    }
}

data class LoginRequest(val phone: String, val password: String)

data class RefreshRequest(val refreshToken: String)

data class AuthTokens(
    val accessToken: String,
    val refreshToken: String,
    val expiresInSec: Long = 0,
    val fullName: String? = null,
    val kycStatus: String? = null,
)

data class MeInfo(
    val id: Long = 0,
    @SerializedName("full_name") val fullName: String? = null,
    val phone: String? = null,
    @SerializedName("national_id") val nationalId: String = "",
    @SerializedName("kyc_status") val kycStatus: String? = null,
    val role: String? = null,
)

data class WalletDto(
    val currency: String,
    val balance: String? = null,
    val balanceMinor: String,
    val updatedAt: String? = null,
)

data class PairRate(val rate: Double = 0.0, val fetchedAt: String? = null)

data class RatesResponse(
    val base: String? = null,
    val pairs: Map<String, PairRate> = emptyMap(),
    val supported: List<String> = emptyList(),
)

data class QrCreateRequest(val amount: String, val currency: String)

data class QrCreateResponse(
    val payload: String,
    val currency: String = "",
    val amountMinor: String = "",
    val expiresInSec: Int = 60,
)

data class QrPreviewRequest(val payload: String)

data class QrPreviewResponse(
    val payeeName: String? = null,
    val amount: String? = null,
    val amountMinor: String? = null,
    val currency: String? = null,
    val expiresInSec: Int? = null,
)

data class ExecuteQrRequest(val payload: String, val biometricConfirmed: Boolean = true)

data class P2pRequest(
    val phone: String,
    val amount: String,
    val currency: String,
    val biometricConfirmed: Boolean = true,
)

data class FakkaRequest(
    val phone: String,
    val amount: String,
    val from: String,
    val to: String,
    val biometricConfirmed: Boolean = true,
)

data class FxRequest(
    val from: String,
    val to: String,
    val amount: String,
    val biometricConfirmed: Boolean = true,
)

data class TxResult(
    val txUuid: String = "",
    val amount: String = "",
    val currency: String = "",
    val counterparty: String = "",
    val newBalanceMinor: String = "",
    val occurredAt: String? = null,
)

data class FakkaResult(
    val txUuid: String? = null,
    val sent: String? = null,
    val customerReceived: String? = null,
    val appliedRate: Double? = null,
    val counterparty: String? = null,
    val newBalanceMinor: String? = null,
)

data class FxResult(
    val txUuid: String? = null,
    val debited: String? = null,
    val credited: String? = null,
    val appliedRate: Double? = null,
    val newFromBalanceMinor: String? = null,
    val newToBalanceMinor: String? = null,
)

data class FcmTokenRequest(val token: String, val deviceInfo: String)

data class LedgerEntry(
    val id: Long = 0,
    val txUuid: String? = null,
    val direction: String,
    val type: String,
    val currency: String,
    val amount: String,
    val signedAmount: String? = null,
    val balanceBefore: String? = null,
    val balanceAfter: String? = null,
    val counterparty: String? = null,
    val appliedRate: String? = null,
    val occurredAt: String? = null,
)

data class LedgerResponse(
    val items: List<LedgerEntry> = emptyList(),
    val hasMore: Boolean = false,
    val nextCursor: Long? = null,
)

data class StatementRequest(val from: String, val to: String, val currencies: List<String>)

data class StatementJobCreated(
    val jobId: Long = 0,
    val status: String? = null,
    val pollUrl: String? = null,
)

data class StatementJob(
    val jobId: Long = 0,
    val status: String? = null,
    val from: String? = null,
    val to: String? = null,
    val error: String? = null,
    val sha256: String? = null,
    val downloadUrl: String? = null,
    val downloadExpiresInSec: Int? = null,
)

// ═══════════════ Retrofit service ═══════════════

interface ApiService {
    @POST("api/auth/login")
    suspend fun login(@Body body: LoginRequest): Envelope<AuthTokens>

    @POST("api/auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): Envelope<AuthTokens>

    @POST("api/auth/logout")
    suspend fun logout(@Body body: RefreshRequest): Envelope<Map<String, Boolean>>

    @GET("api/me")
    suspend fun me(): Envelope<MeInfo>

    @GET("api/wallets")
    suspend fun wallets(): Envelope<List<WalletDto>>

    @GET("api/rates")
    suspend fun rates(): Envelope<RatesResponse>

    @GET("api/ledger")
    suspend fun ledger(
        @Query("from") from: String? = null,
        @Query("to") to: String? = null,
        @Query("type") type: String? = null,
        @Query("currency") currency: String? = null,
        @Query("counterpartyPhone") counterpartyPhone: String? = null,
        @Query("before") before: Long? = null,
        @Query("limit") limit: Int = 30,
    ): Envelope<LedgerResponse>

    @POST("api/qr")
    suspend fun createQr(@Body body: QrCreateRequest): Envelope<QrCreateResponse>

    @POST("api/qr/preview")
    suspend fun previewQr(@Body body: QrPreviewRequest): Envelope<QrPreviewResponse>

    @POST("api/transactions/qr")
    suspend fun executeQr(@Body body: ExecuteQrRequest): Envelope<TxResult>

    @POST("api/transactions/p2p")
    suspend fun transferP2p(@Body body: P2pRequest): Envelope<TxResult>

    @POST("api/transactions/fakka")
    suspend fun sendFakka(@Body body: FakkaRequest): Envelope<FakkaResult>

    @POST("api/transactions/fx")
    suspend fun convertFx(@Body body: FxRequest): Envelope<FxResult>

    @POST("api/devices/fcm")
    suspend fun registerFcm(@Body body: FcmTokenRequest): Envelope<Map<String, Boolean>>

    @POST("api/statements")
    suspend fun requestStatement(@Body body: StatementRequest): Envelope<StatementJobCreated>

    @GET("api/statements/{id}")
    suspend fun statementJob(@Path("id") id: Long): Envelope<StatementJob>
}

// ═══════════════ Client singleton ═══════════════

object ApiClient {

    @Volatile private var service: ApiService? = null
    @Volatile private var retrofitRef: Retrofit? = null

    var onSessionExpired: (() -> Unit)? = null
    var onTokensRotated: ((String, String) -> Unit)? = null

    private val accessToken = AtomicReference<String?>(null)
    private val refreshInProgress = AtomicReference<String?>(null)

    val currentToken: String? get() = accessToken.get()

    fun setAccessToken(token: String?) = accessToken.set(token)
    fun setRefreshToken(refresh: String?) = refreshInProgress.set(refresh)

    // the UI reads this nullable service everywhere
    val apiService: ApiService?
        get() = service

    fun init(appCtx: Context) {
        if (retrofitRef != null) return
        synchronized(this) {
            if (retrofitRef != null) return
            val retrofit = Retrofit.Builder()
                .baseUrl(ensureSlash(BuildConfig.API_BASE_URL))
                .client(buildClient())
                .addConverterFactory(GsonConverterFactory.create())
                .build()
            retrofitRef = retrofit
            service = retrofit.create(ApiService::class.java)
        }
    }

    private fun ensureSlash(url: String): String =
        if (url.endsWith("/")) url else "$url/"

    /** Base OkHttp builder — timeouts + certificate pinning (shared by API, WS, uploads). */
    fun baseClientBuilder(): OkHttpClient.Builder {
        val builder = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
        if (BuildConfig.PINNING_ENABLED && BuildConfig.SSL_PINS != "NOPIN") {
            val host = BuildConfig.API_BASE_URL
                .removePrefix("https://").removePrefix("http://")
                .split("/").first().split(":").first()
            val pins = BuildConfig.SSL_PINS.split(",")
                .map { it.trim() }.filter { it.isNotBlank() }
            val pinner = CertificatePinner.Builder().apply {
                pins.forEach { add(host, it) }
            }.build()
            builder.certificatePinner(pinner)
        }
        return builder
    }

    private fun buildClient(): OkHttpClient =
        baseClientBuilder()
            .addInterceptor { chain ->
                val b = chain.request().newBuilder()
                accessToken.get()?.let { b.header("Authorization", "Bearer $it") }
                b.header("Accept", "application/json")
                chain.proceed(b.build())
            }
            .addInterceptor { chain ->
                val resp = chain.proceed(chain.request())
                if (resp.code == 401 && accessToken.get() != null) {
                    resp.close()
                    val fresh = tryRefresh()
                    if (fresh != null) {
                        return@addInterceptor chain.proceed(
                            chain.request().newBuilder().header("Authorization", "Bearer $fresh").build()
                        )
                    }
                    onSessionExpired?.invoke()
                }
                resp
            }
            .build()

    @Synchronized
    private fun tryRefresh(): String? {
        val refresh = refreshInProgress.get() ?: return null
        return try {
            val client = baseClientBuilder().readTimeout(15, TimeUnit.SECONDS).build()
            val json = Gson().toJson(RefreshRequest(refresh))
            val body = json.toRequestBody("application/json; charset=utf-8".toMediaType())
            client.newCall(
                Request.Builder()
                    .url(ensureSlash(BuildConfig.API_BASE_URL) + "api/auth/refresh")
                    .post(body).build()
            ).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val raw = resp.body?.string() ?: return null
                val type = object : TypeToken<Envelope<AuthTokens>>() {}.type
                @Suppress("UNCHECKED_CAST")
                val env = Gson().fromJson<Envelope<AuthTokens>>(raw, type)
                val tokens = env?.data ?: return null
                accessToken.set(tokens.accessToken)
                refreshInProgress.set(tokens.refreshToken)
                onTokensRotated?.invoke(tokens.accessToken, tokens.refreshToken)
                tokens.accessToken
            }
        } catch (e: Exception) {
            if (e is SSLPeerUnverifiedException) throw e
            null
        }
    }
}
