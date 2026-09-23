package com.fakah.wallet.ui.main

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.WalletDto
import com.fakah.wallet.data.ws.LiveSocket
import com.fakah.wallet.databinding.FragmentWalletBinding
import com.fakah.wallet.ui.common.toast
import com.fakah.wallet.ui.transfer.ConvertActivity
import com.fakah.wallet.ui.transfer.FakkaActivity
import com.fakah.wallet.ui.transfer.TransferActivity
import kotlinx.coroutines.launch
import org.json.JSONObject

class WalletFragment : Fragment() {

    private var _binding: FragmentWalletBinding? = null
    private val binding get() = _binding!!

    private val liveListener: (String, JSONObject) -> Unit = { type, payload ->
        if (type == "wallet_update") {
            val ccy = payload.optString("ccy")
            val balance = payload.optString("balanceMinor")
            val tx = payload.optString("txUuid")
            view?.post {
                if (_binding == null) return@post
                updateCard(ccy, balance)
                toast("تحديث لحظي: عملية جديدة ($tx.take(8))")
                reloadWallets()
            }
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentWalletBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.swipeRefresh.setOnRefreshListener { reloadWallets() }
        binding.btnTransfer.setOnClickListener { startActivity(Intent(requireContext(), TransferActivity::class.java)) }
        binding.btnFakka.setOnClickListener { startActivity(Intent(requireContext(), FakkaActivity::class.java)) }
        binding.btnConvert.setOnClickListener { startActivity(Intent(requireContext(), ConvertActivity::class.java)) }
        LiveSocket.addListener(liveListener)
        reloadWallets()
    }

    override fun onDestroyView() {
        LiveSocket.removeListener(liveListener)
        _binding = null
        super.onDestroyView()
    }

    private fun updateCard(ccy: String, balanceMinor: String) {
        try {
            val value = (balanceMinor.toLong()) / scaleOf(ccy)
            when (ccy) {
                "ILS" -> binding.tvBalanceIls.text = formatAmount(value, ccy)
                "USD" -> binding.tvBalanceUsd.text = formatAmount(value, ccy)
                "JOD" -> binding.tvBalanceJod.text = formatAmount(value, ccy)
            }
        } catch (_: Exception) { }
    }

    private fun scaleOf(ccy: String) = when (ccy) { "JOD" -> 1000.0; else -> 100.0 }

    private fun formatAmount(v: Double, ccy: String) =
        "%,.${if (ccy == "JOD") 3 else 2}f %s".format(v, ccy)

    private fun reloadWallets() {
        lifecycleScope.launch {
            try {
                val env: Envelope<List<WalletDto>> = ApiClient.apiService?.wallets()
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    for (w in env.data) updateCard(w.currency, w.balanceMinor)
                } else {
                    if (env.error?.code == "KYC_PENDING") showPending()
                }
            } catch (e: Exception) {
                // silent — swipe refresh stops anyway
            } finally {
                binding.swipeRefresh.isRefreshing = false
            }
        }
    }

    private fun showPending() {
        view?.post {
            if (_binding == null) return@post
            binding.tvPendingNotice.visibility = View.VISIBLE
        }
    }
}
