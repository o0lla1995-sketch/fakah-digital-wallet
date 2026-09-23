package com.fakah.wallet.ui.main

import android.graphics.Bitmap
import android.os.Bundle
import android.os.CountDownTimer
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.ExecuteQrRequest
import com.fakah.wallet.data.api.QrCreateRequest
import com.fakah.wallet.data.api.QrCreateResponse
import com.fakah.wallet.data.api.QrPreviewRequest
import com.fakah.wallet.data.api.QrPreviewResponse
import com.fakah.wallet.data.api.TxResult
import com.fakah.wallet.databinding.FragmentQrBinding
import com.fakah.wallet.ui.common.BiometricGate
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.launch

class QrFragment : Fragment() {

    private var _binding: FragmentQrBinding? = null
    private val binding get() = _binding!!
    private var countdown: CountDownTimer? = null
    private var currentPayload: String? = null

    // ── scanner launcher (journeyapps embedded handles camera + permission) ──
    private val scanner = registerForActivityResult(com.journeyapps.barcodescanner.ScanContract()) { result ->
        val contents = result?.contents
        if (!contents.isNullOrBlank() && contents.startsWith("v1.")) {
            previewAndConfirm(contents)
        } else if (!contents.isNullOrBlank()) {
            toast("الكود ليس كود دفع فكة صالحاً")
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentQrBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.btnGenerate.setOnClickListener { generateQr() }
        binding.btnScan.setOnClickListener { launchScanner() }
    }

    override fun onDestroyView() {
        countdown?.cancel()
        _binding = null
        super.onDestroyView()
    }

    // ═══════ generate (receive money / show my payment code) ═══════
    private fun generateQr() {
        val amountStr = binding.etAmount.text.toString().trim()
        val amount = amountStr.toDoubleOrNull()
        if (amount == null || amount <= 0) {
            binding.etAmount.error = "أدخل مبلغاً صحيحاً"
            return
        }
        val ccy = when (binding.rgCurrency.checkedRadioButtonId) {
            binding.rbUsd.id -> "USD"; binding.rbJod.id -> "JOD"; else -> "ILS"
        }

        binding.btnGenerate.isEnabled = false
        lifecycleScope.launch {
            try {
                val env: Envelope<QrCreateResponse> = ApiClient.apiService?.createQr(QrCreateRequest(amountStr, ccy))
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    showQr(env.data)
                } else {
                    toast(errorToArabic(env.error?.code ?: "VALIDATION_ERROR"))
                }
            } catch (e: Exception) {
                toast("تعذر الاتصال بالخادم")
            } finally {
                binding.btnGenerate.isEnabled = true
            }
        }
    }

    private fun showQr(qr: QrCreateResponse) {
        currentPayload = qr.payload
        val bitmap = generateQrBitmap(qr.payload, 600)
        binding.ivQr.setImageBitmap(bitmap)
        binding.tvQrAmount.text = "%s %s".format(
            binding.etAmount.text.toString().trim(), qr.currency)
        binding.tvQrExpiry.visibility = View.VISIBLE
        binding.cardQrResult.visibility = View.VISIBLE
        binding.tvQrHint.text = "اعرض هذا الكود للدافع — صالح لدقيقة واحدة فقط"

        countdown?.cancel()
        countdown = object : CountDownTimer(qr.expiresInSec * 1000L, 1000L) {
            override fun onTick(millis: Long) {
                binding.tvQrExpiry.text = "الصلاحية: ${millis / 1000 + 1} ثانية"
            }

            override fun onFinish() {
                binding.tvQrExpiry.text = "انتهت الصلاحية — ولّد كوداً جديداً"
                binding.cardQrResult.visibility = View.GONE
                currentPayload = null
            }
        }.start()
    }

    private fun generateQrBitmap(content: String, size: Int): Bitmap {
        val hints = mapOf(
            EncodeHintType.CHARACTER_SET to "UTF-8",
            EncodeHintType.MARGIN to 1,
        )
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size, hints)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        for (x in 0 until size) {
            for (y in 0 until size) {
                bmp.setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
            }
        }
        return bmp
    }

    // ═══════ scan (pay) ═══════
    private fun launchScanner() {
        scanner.launch(
            com.journeyapps.barcodescanner.ScanOptions().apply {
                setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                setPrompt("وجّه الكاميرا نحو كود الدفع")
                setBeepEnabled(false)
                setOrientationLocked(true)
            }
        )
    }

    private fun previewAndConfirm(payload: String) {
        lifecycleScope.launch {
            try {
                val env: Envelope<QrPreviewResponse> = ApiClient.apiService?.previewQr(QrPreviewRequest(payload))
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (!env.success || env.data == null) {
                    toast(errorToArabic(env.error?.code ?: "QR_PAYLOAD_MISMATCH"))
                    return@launch
                }
                confirmDialog(payload, env.data)
            } catch (e: Exception) {
                toast("تعذر التحقق من الكود")
            }
        }
    }

    private fun confirmDialog(payload: String, preview: QrPreviewResponse) {
        val activity = requireActivity() as androidx.fragment.app.FragmentActivity
        AlertDialog.Builder(requireContext())
            .setTitle("تأكيد الدفع")
            .setMessage(
                "المبلغ: ${preview.amount}\n" +
                    "المستفيد: ${preview.payeeName}\n\n" +
                    "سيُطلب تأكيد بصمتك لإتمام العملية."
            )
            .setPositiveButton("متابعة") { _, _ ->
                BiometricGate.confirm(
                    activity,
                    "تأكيد دفع ${preview.amount}",
                    onSuccess = { executePayment(payload) },
                    onError = { if (it != "cancelled") toast("تعذر التحقق: $it") },
                    onUnavailable = {
                        toast("الجهاز بلا بصمة مسجّلة — استخدم التحويل المباشر من المحفظة")
                    },
                )
            }
            .setNegativeButton("إلغاء", null)
            .show()
    }

    private fun executePayment(payload: String) {
        lifecycleScope.launch {
            try {
                val env: Envelope<TxResult> = ApiClient.apiService?.executeQr(ExecuteQrRequest(payload))
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    val r = env.data
                    AlertDialog.Builder(requireContext())
                        .setTitle("تم الدفع بنجاح")
                        .setMessage(
                            "المبلغ: ${r.amount}\n" +
                                "المرجع: ${r.txUuid.take(8)}\n" +
                                "الرصيد الجديد: ${r.newBalanceMinor}"
                        )
                        .setPositiveButton("حسناً", null)
                        .show()
                } else {
                    toast(errorToArabic(env.error?.code ?: "VALIDATION_ERROR"))
                }
            } catch (e: Exception) {
                toast("تعذر تنفيذ العملية")
            }
        }
    }
}
