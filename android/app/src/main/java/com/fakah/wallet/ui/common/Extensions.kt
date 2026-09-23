package com.fakah.wallet.ui.common

import android.app.Activity
import android.content.Context
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import com.fakah.wallet.data.api.Envelope
import kotlinx.coroutines.CoroutineExceptionHandler

fun Context.toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

fun androidx.fragment.app.Fragment.toast(msg: String) {
    context?.let { Toast.makeText(it, msg, Toast.LENGTH_LONG).show() }
}

fun Context.toastError(env: Envelope<*>) {
    val code = env.error?.code ?: "UNKNOWN"
    toast(errorToArabic(code))
}

fun errorToArabic(code: String): String = when (code) {
    "INVALID_CREDENTIALS" -> "رقم الجوال أو كلمة المرور غير صحيحة"
    "ACCOUNT_LOCKED" -> "الحساب مقفل مؤقتاً لأسباب أمنية، حاول لاحقاً"
    "KYC_PENDING" -> "حسابك قيد المراجعة، سيتم تفعيله بعد التوثيق"
    "KYC_REJECTED" -> "تم رفض التوثيق، يرجى مراجعة المستندات"
    "QR_EXPIRED" -> "انتهت صلاحية الكود، اطلب كوداً جديداً"
    "QR_ALREADY_USED" -> "هذا الكود مستهلك بالفعل"
    "QR_PAYLOAD_MISMATCH" -> "الكود غير صالح أو مُعدَّل"
    "QR_NOT_FOUND" -> "الكود غير معروف"
    "INSUFFICIENT_FUNDS" -> "الرصيد غير كافٍ لإتمام العملية"
    "PARTY_NOT_VERIFIED", "PAYEE_NOT_VERIFIED", "PAYER_NOT_VERIFIED" -> "الطرف الآخر غير موثق بعد"
    "BIOMETRIC_REQUIRED" -> "مطلوب تأكيد البصمة قبل العملية"
    "RATE_LIMITED" -> "عدد كبير من المحاولات، انتظر قليلاً"
    "NO_ACTIVE_RATE" -> "خدمة أسعار الصرف غير متاحة حالياً"
    "USER_NOT_FOUND" -> "الرقم غير مسجل في النظام"
    "NATIONAL_ID_TAKEN" -> "رقم الهوية مسجل مسبقاً"
    "PHONE_TAKEN" -> "رقم الجوال مسجل مسبقاً"
    "ROUNDED_TO_ZERO" -> "المبلغ صغير جداً بعد التحويل"
    "SAME_CURRENCY" -> "اختر عملتين مختلفتين"
    "SELF_TRANSFER_FORBIDDEN", "SELF_PAYMENT_FORBIDDEN" -> "لا يمكن التحويل لنفسك"
    "WALLETS_NOT_READY" -> "المحافظ غير مهيأة بعد"
    "NETWORK_ERROR" -> "تعذر الاتصال بالخادم، تحقق من الشبكة"
    "VALIDATION_ERROR" -> "تحقق من صحة البيانات المدخلة"
    else -> "حدث خطأ غير متوقع ($code)"
}

fun Activity.hideKeyboard() {
    val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    currentFocus?.let { imm.hideSoftInputFromWindow(it.windowToken, 0) }
}

fun View.visible() { visibility = View.VISIBLE }
fun View.gone() { visibility = View.GONE }

val apiExceptionHandler = CoroutineExceptionHandler { _, throwable ->
    android.util.Log.e("Fakah", "API call failed", throwable)
}
