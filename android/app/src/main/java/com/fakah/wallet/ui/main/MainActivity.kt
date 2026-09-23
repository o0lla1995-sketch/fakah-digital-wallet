package com.fakah.wallet.ui.main

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.fakah.wallet.R
import com.fakah.wallet.data.local.SessionVault
import com.fakah.wallet.data.ws.LiveSocket
import com.fakah.wallet.databinding.ActivityMainBinding
import com.fakah.wallet.push.FcmService
import com.fakah.wallet.ui.common.toast

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    // FLAG_SECURE: block screenshots & recents previews — balances live here
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.ICE_CREAM_SANDWICH) {
            window.setFlags(
                android.view.WindowManager.LayoutParams.FLAG_SECURE,
                android.view.WindowManager.LayoutParams.FLAG_SECURE
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val kyc = SessionVault.kycStatus(this)
        if (kyc != null && kyc != "approved") {
            toast(if (kyc == "pending") "حسابك قيد التوثيق — بعض العمليات ستكون معطلة حتى الاعتماد" else "حالة التوثيق: مرفوض")
        }

        if (savedInstanceState == null) {
            showFragment(WalletFragment(), "wallet")
        }

        binding.bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_wallet -> { showFragment(WalletFragment(), "wallet"); true }
                R.id.nav_qr -> { showFragment(QrFragment(), "qr"); true }
                R.id.nav_ledger -> { showFragment(LedgerFragment(), "ledger"); true }
                R.id.nav_profile -> { showFragment(ProfileFragment(), "profile"); true }
                else -> false
            }
        }
    }

    private fun showFragment(fragment: Fragment, tag: String) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, fragment, tag)
            .commit()
    }

    override fun onStart() {
        super.onStart()
        LiveSocket.start()
        FcmService.tryRegisterCurrentToken(this)
    }

    override fun onStop() {
        LiveSocket.stop()
        super.onStop()
    }
}
