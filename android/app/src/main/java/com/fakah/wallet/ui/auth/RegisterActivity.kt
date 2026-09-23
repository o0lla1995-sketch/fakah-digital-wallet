package com.fakah.wallet.ui.auth

import android.net.Uri
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.databinding.ActivityRegisterBinding
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.hideKeyboard
import com.fakah.wallet.ui.common.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class RegisterActivity : AppCompatActivity() {

    private lateinit var binding: ActivityRegisterBinding
    private val picked = mutableMapOf<String, Uri?>() // id_front / id_back / selfie

    private val picker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        pendingField?.let { picked[it] = uri; refreshPickLabels() }
    }
    private var pendingField: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityRegisterBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnPickFront.setOnClickListener { launchPicker("id_front") }
        binding.btnPickBack.setOnClickListener { launchPicker("id_back") }
        binding.btnPickSelfie.setOnClickListener { launchPicker("selfie") }
        binding.btnRegister.setOnClickListener { attemptRegister() }
        binding.btnBack.setOnClickListener { finish() }
    }

    private fun launchPicker(field: String) {
        pendingField = field
        picker.launch("image/*")
    }

    private fun refreshPickLabels() {
        binding.btnPickFront.text = labelFor("id_front", "رفع صورة الهوية (الوجه الأمامي)")
        binding.btnPickBack.text = labelFor("id_back", "رفع صورة الهوية (الوجه الخلفي)")
        binding.btnPickSelfie.text = labelFor("selfie", "رفع صورة سيلفي")
    }

    private fun labelFor(field: String, base: String): String =
        if (picked[field] != null) "✓ تم اختيار الصورة" else base

    private fun attemptRegister() {
        val name = binding.etFullName.text.toString().trim()
        val nid = binding.etNationalId.text.toString().trim()
        val phone = binding.etPhone.text.toString().trim()
        val pass = binding.etPassword.text.toString()
        val pass2 = binding.etPassword2.text.toString()

        if (name.length < 3 || !name.matches(Regex("^[\\u0600-\\u06FFa-zA-Z\\s'.]{3,120}$"))) {
            binding.etFullName.error = "الاسم كما في الهوية الرسمية"
            return
        }
        if (!Regex("^[0-9]{9}$").matches(nid)) {
            binding.etNationalId.error = "رقم الهوية 9 أرقام بالضبط"
            return
        }
        if (!Regex("^(056|059)[0-9]{7}$").matches(phone)) {
            binding.etPhone.error = "الرقم يبدأ بـ 056 أو 059 متبوعاً بـ 7 أرقام"
            return
        }
        if (pass.length < 8 || !pass.any { it.isDigit() } || !pass.any { it.isLetter() }) {
            binding.etPassword.error = "كلمة المرور: 8 أحرف على الأقل تتضمن حروفاً وأرقاماً"
            return
        }
        if (pass != pass2) {
            binding.etPassword2.error = "كلمتا المرور غير متطابقتين"
            return
        }
        if (picked.values.count { it != null } < 3) {
            toast("يرجى رفع المستندات الثلاثة: وجه الهوية، ظهرها، والسيلفي")
            return
        }

        hideKeyboard()
        setBusy(true)

        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { uploadMultipart(name, nid, phone, pass) }
                if (result.first) {
                    toast("تم إنشاء الحساب — الحالة: قيد المراجعة، سيصلك إشعار فور التوثيق")
                    finish()
                } else {
                    toast(errorToArabic(result.second ?: "VALIDATION_ERROR"))
                }
            } catch (e: Exception) {
                toast("تعذر الاتصال بالخادم، تحقق من الشبكة")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        binding.btnRegister.isEnabled = !busy
        binding.progress.visibility = if (busy) android.view.View.VISIBLE else android.view.View.GONE
    }

    // multipart upload with the three KYC documents (raw OkHttp — files are one-shot)
    private fun uploadMultipart(
        name: String, nid: String, phone: String, pass: String,
    ): Pair<Boolean, String?> {
        val base = com.fakah.wallet.BuildConfig.API_BASE_URL.trimEnd('/')
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("fullName", name)
            .addFormDataPart("nationalId", nid)
            .addFormDataPart("phone", phone)
            .addFormDataPart("password", pass)

        for (field in listOf("id_front", "id_back", "selfie")) {
            val uri = picked[field] ?: continue
            val file = cacheFileFor(uri, field)
            val media = contentResolver.getType(uri)?.toMediaType()
                ?: "image/jpeg".toMediaType()
            form.addFormDataPart(
                field, file.name, file.asRequestBody(media)
            )
        }

        val request = Request.Builder()
            .url("$base/api/auth/register")
            .post(form.build())
            .build()

        com.fakah.wallet.data.api.ApiClient.baseClientBuilder()
            .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
            .build().newCall(request).execute().use { resp ->
                val bodyStr = resp.body?.string() ?: return Pair(false, "NETWORK_ERROR")
                val json = JSONObject(bodyStr)
                if (json.optBoolean("success")) return Pair(true, null)
                val err = json.optJSONObject("error")
                return Pair(false, err?.optString("code"))
            }
    }

    private fun cacheFileFor(uri: Uri, field: String): File {
        val ext = when (contentResolver.getType(uri)) {
            "image/png" -> ".png"; "image/webp" -> ".webp"; else -> ".jpg"
        }
        val f = File(cacheDir, "kyc_$field$ext")
        contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(f).use { output -> input.copyTo(output) }
        }
        return f
    }
}
