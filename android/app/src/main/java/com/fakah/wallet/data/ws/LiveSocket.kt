// LiveSocket.kt — live balance/transaction updates over WebSocket (FCM fallback channel)
package com.fakah.wallet.data.ws

import com.fakah.wallet.BuildConfig
import com.fakah.wallet.data.api.ApiClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object LiveSocket {

    private val listeners = mutableListOf<(String, JSONObject) -> Unit>()
    @Volatile private var ws: WebSocket? = null
    @Volatile private var wantAlive = false

    fun addListener(fn: (String, JSONObject) -> Unit) {
        synchronized(listeners) { listeners.add(fn) }
    }

    fun removeListener(fn: (String, JSONObject) -> Unit) {
        synchronized(listeners) { listeners.remove(fn) }
    }

    fun start() {
        wantAlive = true
        connect()
    }

    fun stop() {
        wantAlive = false
        ws?.close(1000, "app background")
        ws = null
    }

    private fun connect() {
        val token = ApiClient.currentToken ?: return
        if (!wantAlive) return
        val url = BuildConfig.API_BASE_URL
            .replace("https://", "wss://")
            .replace("http://", "ws://")
            .trimEnd('/') + "/ws?token=$token"
        ws = ApiClient.baseClientBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
            .newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    try {
                        val msg = JSONObject(text)
                        val type = msg.optString("type", "")
                        var payload = msg.optJSONObject("payload") ?: JSONObject()
                        val snapshot: List<(String, JSONObject) -> Unit> =
                            synchronized(listeners) { listeners.toList() }
                        snapshot.forEach { it(type, payload) }
                    } catch (_: Exception) {
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    scheduleReconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    scheduleReconnect()
                }
            })
    }

    private fun scheduleReconnect() {
        if (!wantAlive) return
        Thread {
            try { Thread.sleep(4000) } catch (_: InterruptedException) { }
            if (wantAlive) connect()
        }.apply { isDaemon = true }.start()
    }
}
