package com.fakah.wallet.ui.main

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.MeInfo
import com.fakah.wallet.data.local.SessionVault
import com.fakah.wallet.databinding.FragmentProfileBinding
import com.fakah.wallet.ui.auth.LoginActivity
import com.fakah.wallet.ui.common.toast
import kotlinx.coroutines.launch

class ProfileFragment : Fragment() {

    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.tvName.text = SessionVault.fullName(requireContext()) ?: "—"
        binding.tvPhone.text = SessionVault.phone(requireContext()) ?: "—"
        val kyc = SessionVault.kycStatus(requireContext()) ?: "pending"
        binding.tvKyc.text = when (kyc) {
            "approved" -> "الحالة: حساب موثّق ✓"
            "rejected" -> "الحالة: توثيق مرفوض — راجع الدعم"
            else -> "الحالة: قيد المراجعة"
        }

        binding.btnRefresh.setOnClickListener { loadMe() }
        binding.btnLogout.setOnClickListener { logout() }
        loadMe()
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    private fun loadMe() {
        lifecycleScope.launch {
            try {
                val env: Envelope<MeInfo> = ApiClient.apiService?.me()
                    ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                if (env.success && env.data != null) {
                    binding.tvName.text = env.data.fullName
                    binding.tvPhone.text = env.data.phone
                    binding.tvNationalId.text = "الهوية: ${env.data.nationalId.take(2)}••••••${env.data.nationalId.takeLast(2)}"
                }
            } catch (e: Exception) { /* shown from cache */ }
        }
    }

    private fun logout() {
        lifecycleScope.launch {
            try {
                ApiClient.apiService?.logout(
                    com.fakah.wallet.data.api.RefreshRequest(SessionVault.refreshToken(requireContext()) ?: "")
                )
            } catch (_: Exception) { }
            SessionVault.clear(requireContext())
            ApiClient.setAccessToken(null)
            ApiClient.setRefreshToken(null)
            startActivity(Intent(requireContext(), LoginActivity::class.java))
            requireActivity().finishAffinity()
        }
    }
}
