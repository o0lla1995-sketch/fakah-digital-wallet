package com.fakah.wallet.ui.auth

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.LoginRequest
import com.fakah.wallet.data.local.SessionVault
import com.fakah.wallet.databinding.ActivityLoginBinding
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.hideKeyboard
import com.fakah.wallet.ui.common.toast
import com.fakah.wallet.ui.main.MainActivity
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnLogin.setOnClickListener {
            attemptLogin()
        }
        binding.btnGoRegister.setOnClickListener {
            startActivity(Intent(this, RegisterActivity::class.java))
        }
    }

    private fun attemptLogin() {
        val phone = binding.etPhone.text.toString().trim()
        val password = binding.etPassword.text.toString()
        if (!Regex("^(056|059)[0-9]{7}$").matches(phone)) {
            binding.etPhone.error = "الرقم يجب أن يبدأ بـ 056 أو 059 ويتكون من 10 أرقام"
            return
        }
        if (password.length < 8) {
            binding.etPassword.error = "كلمة المرور 8 أحرف على الأقل"
            return
        }
        hideKeyboard()
        setLoading(true)

        lifecycleScope.launch {
            try {
                val env: Envelope<com.fakah.wallet.data.api.AuthTokens> =
                    ApiClient.apiService?.login(LoginRequest(phone, password))
                        ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    SessionVault.saveSession(
                        this@LoginActivity, env.data.accessToken, env.data.refreshToken,
                        env.data.fullName, phone, env.data.kycStatus
                    )
                    ApiClient.setAccessToken(env.data.accessToken)
                    ApiClient.setRefreshToken(env.data.refreshToken)
                    ApiClient.onTokensRotated = { access, refresh ->
                        SessionVault.saveSession(
                            this@LoginActivity, access, refresh,
                            SessionVault.fullName(this@LoginActivity),
                            phone, SessionVault.kycStatus(this@LoginActivity)
                        )
                    }
                    if (env.data.kycStatus == "rejected") {
                        toast("تم رفض التوثيق سابقاً — راجع قسم الملف")
                    }
                    startActivity(Intent(this@LoginActivity, MainActivity::class.java))
                    finish()
                } else {
                    toast(errorToArabic(env.error?.code ?: "INVALID_CREDENTIALS"))
                }
            } catch (e: Exception) {
                toast("تعذر الاتصال بالخادم، تحقق من الشبكة")
            } finally {
                setLoading(false)
            }
        }
    }

    private fun setLoading(loading: Boolean) {
        binding.btnLogin.isEnabled = !loading
        binding.progress.visibility = if (loading) android.view.View.VISIBLE else android.view.View.GONE
    }
}
