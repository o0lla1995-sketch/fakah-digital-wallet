package com.fakah.wallet.ui.splash

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.local.SessionVault
import com.fakah.wallet.ui.auth.LoginActivity
import com.fakah.wallet.ui.main.MainActivity
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SplashActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        lifecycleScope.launch {
            delay(400)
            val hasSession = SessionVault.hasSession(this@SplashActivity)
            if (hasSession) {
                ApiClient.setAccessToken(SessionVault.accessToken(this@SplashActivity))
                ApiClient.setRefreshToken(SessionVault.refreshToken(this@SplashActivity))
                ApiClient.onTokensRotated = { access, refresh ->
                    SessionVault.saveSession(
                        this@SplashActivity, access, refresh,
                        SessionVault.fullName(this@SplashActivity),
                        SessionVault.phone(this@SplashActivity),
                        SessionVault.kycStatus(this@SplashActivity)
                    )
                }
                startActivity(Intent(this@SplashActivity, MainActivity::class.java))
            } else {
                startActivity(Intent(this@SplashActivity, LoginActivity::class.java))
            }
            finish()
        }
    }
}
