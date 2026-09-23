package com.fakah.wallet.ui.transfer

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.FxRequest
import com.fakah.wallet.data.api.FxResult
import com.fakah.wallet.databinding.ActivityConvertBinding
import com.fakah.wallet.ui.common.BiometricGate
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.hideKeyboard
import com.fakah.wallet.ui.common.toast
import kotlinx.coroutines.launch

class ConvertActivity : AppCompatActivity() {

    private lateinit var binding: ActivityConvertBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        binding = ActivityConvertBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnConvert.setOnClickListener { validateAndConvert() }
        binding.btnBack.setOnClickListener { finish() }
    }

    private fun validateAndConvert() {
        val amountStr = binding.etAmount.text.toString().trim()
        val amount = amountStr.toDoubleOrNull()
        if (amount == null || amount <= 0) {
            binding.etAmount.error = "أدخل مبلغاً صحيحاً"
            return
        }
        val from = when (binding.rgFrom.checkedRadioButtonId) {
            binding.rbFromUsd.id -> "USD"; binding.rbFromJod.id -> "JOD"; else -> "ILS"
        }
        val to = when (binding.rgTo.checkedRadioButtonId) {
            binding.rbToUsd.id -> "USD"; binding.rbToJod.id -> "JOD"; else -> "ILS"
        }
        if (from == to) {
            toast("اختر عملتين مختلفتين")
            return
        }

        hideKeyboard()
        BiometricGate.confirm(
            this as FragmentActivity,
            "تأكيد تحويل $amountStr $from إلى $to",
            onSuccess = { convert(amountStr, from, to) },
            onError = { if (it != "cancelled") toast("تعذر التحقق: $it") },
            onUnavailable = { toast("سجّل بصمة في إعدادات الجهاز أولاً") },
        )
    }

    private fun convert(amount: String, from: String, to: String) {
        setBusy(true)
        lifecycleScope.launch {
            try {
                val env: Envelope<FxResult> = ApiClient.apiService?.convertFx(FxRequest(from, to, amount))
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    val r = env.data
                    toast("تم التحويل: ${r.debited} ← ${r.credited} (السعر: ${r.appliedRate})")
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
        binding.btnConvert.isEnabled = !busy
        binding.progress.visibility = if (busy) View.VISIBLE else View.GONE
    }
}
