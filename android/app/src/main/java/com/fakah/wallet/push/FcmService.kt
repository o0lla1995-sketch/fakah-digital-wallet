package com.fakah.wallet.push

import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.FcmTokenRequest
import com.fakah.wallet.data.local.SessionVault
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * FcmService — push notifications channel.
 * Works fully once google-services.json is added to the app module; until then
 * the Firebase init no-ops safely and the app relies on WebSocket + pull refresh.
 */
class FcmService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        registerToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        val data = message.data
        val type = data["type"] ?: return
        // wallet_update / tx_completed / tx_received / kyc_approved / kyc_rejected / statement_ready
        // fragments observe via LiveEventBus-compatible broadcast below
        val intent = android.content.Intent(ACTION_FCM_EVENT).apply {
            putExtra("type", type)
            data.forEach { (k, v) -> putExtra(k, v) }
        }
        sendBroadcast(intent.setPackage(packageName))
    }

    companion object {
        const val ACTION_FCM_EVENT = "com.fakah.wallet.FCM_EVENT"

        fun tryRegisterCurrentToken(ctx: android.content.Context) {
            try {
                val token = FirebaseMessaging.getInstance().token.result
                if (token != null) registerToken(ctx, token)
            } catch (e: Exception) {
                // Firebase not configured (no google-services.json) — push disabled, app stays functional
            }
        }

        private fun registerToken(ctx: android.content.Context, token: String) {
            if (SessionVault.accessToken(ctx) == null) return
            val api = ApiClient.apiService ?: return
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    api.registerFcm(FcmTokenRequest(token, android.os.Build.MODEL ?: "android"))
                } catch (_: Exception) { }
            }
        }
    }
}
