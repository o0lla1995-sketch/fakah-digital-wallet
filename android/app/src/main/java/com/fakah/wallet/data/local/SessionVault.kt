// SessionVault.kt — Keystore-encrypted session storage (AES-256-GCM)
package com.fakah.wallet.data.local

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SessionVault {

    private const val PREFS = "fakah_secure"
    private const val KS_ALIAS = "fakah_session_key"
    private const val KEY_ACCESS = "access_token"
    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_NAME = "full_name"
    private const val KEY_PHONE = "phone"
    private const val KEY_KYC = "kyc_status"

    private fun obtainKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(KS_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val kg = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        kg.init(
            KeyGenParameterSpec.Builder(
                KS_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return kg.generateKey()
    }

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ── crypto helpers ──
    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, obtainKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + ct, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String?): String? {
        if (encoded == null) return null
        return try {
            val blob = Base64.decode(encoded, Base64.NO_WRAP)
            val iv = blob.copyOfRange(0, 12)
            val ct = blob.copyOfRange(12, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, obtainKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    // ── public API ──
    fun saveSession(ctx: Context, access: String, refresh: String, name: String?, phone: String?, kyc: String?) {
        val e = prefs(ctx).edit()
        e.putString(KEY_ACCESS, encrypt(access))
        e.putString(KEY_REFRESH, encrypt(refresh))
        name?.let { e.putString(KEY_NAME, encrypt(it)) }
        phone?.let { e.putString(KEY_PHONE, encrypt(it)) }
        kyc?.let { e.putString(KEY_KYC, encrypt(it)) }
        e.apply()
    }

    fun hasSession(ctx: Context): Boolean =
        decrypt(prefs(ctx).getString(KEY_ACCESS, null)) != null

    fun accessToken(ctx: Context): String? = decrypt(prefs(ctx).getString(KEY_ACCESS, null))
    fun refreshToken(ctx: Context): String? = decrypt(prefs(ctx).getString(KEY_REFRESH, null))
    fun fullName(ctx: Context): String? = decrypt(prefs(ctx).getString(KEY_NAME, null))
    fun phone(ctx: Context): String? = decrypt(prefs(ctx).getString(KEY_PHONE, null))
    fun kycStatus(ctx: Context): String? = decrypt(prefs(ctx).getString(KEY_KYC, null))

    fun clear(ctx: Context) {
        prefs(ctx).edit().clear().apply()
    }
}
