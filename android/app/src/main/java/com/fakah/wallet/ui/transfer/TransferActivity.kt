package com.fakah.wallet.ui.transfer

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.P2pRequest
import com.fakah.wallet.data.api.TxResult
import com.fakah.wallet.databinding.ActivityTransferBinding
import com.fakah.wallet.ui.common.BiometricGate
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.hideKeyboard
import com.fakah.wallet.ui.common.toast
import kotlinx.coroutines.launch

class TransferActivity : AppCompatActivity() {

    private lateinit var binding: ActivityTransferBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        binding = ActivityTransferBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnSend.setOnClickListener { validateAndSend() }
        binding.btnBack.setOnClickListener { finish() }
    }

    private fun validateAndSend() {
        val phone = binding.etPhone.text.toString().trim()
        val amountStr = binding.etAmount.text.toString().trim()
        val amount = amountStr.toDoubleOrNull()

        if (!Regex("^(056|059)[0-9]{7}$").matches(phone)) {
            binding.etPhone.error = "رقم غير صالح (056/059)"
            return
        }
        if (amount == null || amount <= 0) {
            binding.etAmount.error = "أدخل مبلغاً صحيحاً"
            return
        }
        val ccy = when (binding.rgCurrency.checkedRadioButtonId) {
            binding.rbUsd.id -> "USD"; binding.rbJod.id -> "JOD"; else -> "ILS"
        }

        hideKeyboard()
        BiometricGate.confirm(
            this as FragmentActivity,
            "تأكيد تحويل $amountStr $ccy",
            onSuccess = { send(phone, amountStr, ccy) },
            onError = { if (it != "cancelled") toast("تعذر التحقق: $it") },
            onUnavailable = { toast("سجّل بصمة في إعدادات الجهاز أولاً لعمليات التحويل") },
        )
    }

    private fun send(phone: String, amount: String, ccy: String) {
        setBusy(true)
        lifecycleScope.launch {
            try {
                val env: Envelope<TxResult> = ApiClient.apiService?.transferP2p(P2pRequest(phone, amount, ccy))
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    toast("تم التحويل بنجاح — ${env.data.amount}")
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
        binding.btnSend.isEnabled = !busy
        binding.progress.visibility = if (busy) View.VISIBLE else View.GONE
    }
}
