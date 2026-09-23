package com.fakah.wallet.ui.transfer

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.FakkaRequest
import com.fakah.wallet.data.api.FakkaResult
import com.fakah.wallet.databinding.ActivityFakkaBinding
import com.fakah.wallet.ui.common.BiometricGate
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.hideKeyboard
import com.fakah.wallet.ui.common.toast
import kotlinx.coroutines.launch

class FakkaActivity : AppCompatActivity() {

    private lateinit var binding: ActivityFakkaBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        binding = ActivityFakkaBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnSendFakka.setOnClickListener { validateAndSend() }
        binding.btnBack.setOnClickListener { finish() }
    }

    private fun validateAndSend() {
        val phone = binding.etPhone.text.toString().trim()
        val amountStr = binding.etAmount.text.toString().trim()
        val amount = amountStr.toDoubleOrNull()

        if (!Regex("^(056|059)[0-9]{7}$").matches(phone)) {
            binding.etPhone.error = "رقم الزبون غير صالح"
            return
        }
        if (amount == null || amount <= 0) {
            binding.etAmount.error = "أدخل مبلغ الفكة"
            return
        }
        val from = when (binding.rgFrom.checkedRadioButtonId) {
            binding.rbFromUsd.id -> "USD"; binding.rbFromJod.id -> "JOD"; else -> "ILS"
        }
        val to = when (binding.rgTo.checkedRadioButtonId) {
            binding.rbToUsd.id -> "USD"; binding.rbToJod.id -> "JOD"; else -> "ILS"
        }

        hideKeyboard()
        BiometricGate.confirm(
            this as FragmentActivity,
            "تأكيد إرجاع فكة $amountStr $from",
            onSuccess = { send(phone, amountStr, from, to) },
            onError = { if (it != "cancelled") toast("تعذر التحقق: $it") },
            onUnavailable = { toast("سجّل بصمة في إعدادات الجهاز أولاً") },
        )
    }

    private fun send(phone: String, amount: String, from: String, to: String) {
        setBusy(true)
        lifecycleScope.launch {
            try {
                val env: Envelope<FakkaResult> = ApiClient.apiService?.sendFakka(FakkaRequest(phone, amount, from, to))
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    toast("أُرجعت الفكة: استلم الزبون ${env.data.customerReceived}")
                    finish()
                } else {
                    toast(errorToArabic(env.error?.code ?: "VALIDATION_ERROR"))
                }
            } catch (e: Exception) {
                toast("تعذر الاتصال بالخادم")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        binding.btnSendFakka.isEnabled = !busy
        binding.progress.visibility = if (busy) View.VISIBLE else View.GONE
    }
}
