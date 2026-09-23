package com.fakah.wallet.ui.main

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.data.api.ApiClient
import com.fakah.wallet.data.api.Envelope
import com.fakah.wallet.data.api.LedgerEntry
import com.fakah.wallet.data.api.LedgerResponse
import com.fakah.wallet.data.api.StatementJob
import com.fakah.wallet.data.api.StatementRequest
import com.fakah.wallet.data.api.StatementJobCreated
import com.fakah.wallet.data.ws.LiveSocket
import com.fakah.wallet.databinding.FragmentLedgerBinding
import com.fakah.wallet.ui.common.errorToArabic
import com.fakah.wallet.ui.common.toast
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

class LedgerFragment : Fragment() {

    private var _binding: FragmentLedgerBinding? = null
    private val binding get() = _binding!!
    private var cursor: Long? = null
    private var items = listOf<LedgerEntry>()

    private val liveListener: (String, JSONObject) -> Unit = { type, _ ->
        if (type == "wallet_update" || type == "settlement") {
            view?.post { reload() }
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentLedgerBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.swipeRefresh.setOnRefreshListener { reload() }
        binding.btnFilter.setOnClickListener { reload() }
        binding.btnStatement.setOnClickListener { requestStatement() }
        binding.btnLoadMore.setOnClickListener { loadMore() }

        val types = listOf("الكل", "دفع QR", "فكة رقمية", "تحويل", "تحويل عملة")
        binding.spType.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, types)
        val ccys = listOf("الكل", "ILS", "USD", "JOD")
        binding.spCurrency.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, ccys)

        LiveSocket.addListener(liveListener)
        reload()
    }

    override fun onDestroyView() {
        LiveSocket.removeListener(liveListener)
        _binding = null
        super.onDestroyView()
    }

    private fun typeCode(): String? = when (binding.spType.selectedItemPosition) {
        1 -> "qr_payment"; 2 -> "fakka_deposit"; 3 -> "p2p_transfer"; 4 -> "fx_conversion"; else -> null
    }

    private fun ccyCode(): String? = if (binding.spCurrency.selectedItemPosition == 0) null
    else binding.spCurrency.selectedItem.toString()

    private fun dateIso(daysBack: Int): String {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DAY_OF_MONTH, -daysBack)
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
    }

    private fun reload() {
        cursor = null
        items = emptyList()
        loadPage(true)
    }

    private fun loadMore() = loadPage(false)

    private fun loadPage(first: Boolean) {
        lifecycleScope.launch {
            try {
                val env: Envelope<LedgerResponse> = ApiClient.apiService?.ledger(
                    from = dateIso(30), to = null,
                    type = typeCode(), currency = ccyCode(),
                    counterpartyPhone = null, before = cursor,
                ) ?: Envelope.failed("NETWORK_ERROR", "api unavailable")

                if (env.success && env.data != null) {
                    items = if (first) env.data.items else items + env.data.items
                    cursor = env.data.nextCursor
                    render()
                } else {
                    toast(errorToArabic(env.error?.code ?: "VALIDATION_ERROR"))
                }
            } catch (e: Exception) {
                toast("تعذر تحميل السجل")
            } finally {
                binding.swipeRefresh.isRefreshing = false
            }
        }
    }

    private fun render() {
        val fmt = SimpleDateFormat("MM-dd HH:mm", Locale.US)
        val lines = items.map { e ->
            val sign = if (e.direction == "debit") "-" else "+"
            val who = e.counterparty ?: "—"
            val typeAr = when (e.type) {
                "qr_payment" -> "دفع QR"; "fakka_deposit" -> "فكة"; "p2p_transfer" -> "تحويل"; else -> "صرف"
            }
            "%s | %s %s %s | %s".format(fmt.format(Date(e.occurredAt)), sign, e.amount, e.currency, "$typeAr · $who")
        }
        binding.lvLedger.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, lines)
        binding.tvEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        binding.btnLoadMore.visibility = if (cursor != null) View.VISIBLE else View.GONE
    }

    // ── statement (PDF job) ──
    private fun requestStatement() {
        binding.btnStatement.isEnabled = false
        lifecycleScope.launch {
            try {
                val env: Envelope<StatementJobCreated> = ApiClient.apiService?.requestStatement(
                    StatementRequest(dateIso(30), dateIso(0), listOf("ILS", "USD", "JOD"))
                ) ?: Envelope.failed("NETWORK_ERROR", "api unavailable")

                if (!env.success || env.data == null) {
                    toast(errorToArabic(env.error?.code ?: "VALIDATION_ERROR"))
                    return@launch
                }
                toast("بدأ توليد الكشف — سيجهز خلال لحظات")
                val jobId = env.data.jobId
                // poll the background job until done
                for (i in 1..20) {
                    delay(1500)
                    val jobEnv: Envelope<StatementJob> = ApiClient.apiService?.statementJob(jobId)
                        ?: Envelope.failed("NETWORK_ERROR", "api unavailable")
                    val job = jobEnv.data
                    if (job != null && job.status == "done" && job.downloadUrl != null) {
                        openPdf(job.downloadUrl!!)
                        break
                    }
                    if (job != null && job.status == "failed") {
                        toast("فشل توليد الكشف: ${job.error ?: ""}")
                        break
                    }
                }
            } catch (e: Exception) {
                toast("تعذر طلب الكشف")
            } finally {
                binding.btnStatement.isEnabled = true
            }
        }
    }

    private fun openPdf(url: String) {
        try {
            val full = if (url.startsWith("http")) url else
                com.fakah.wallet.BuildConfig.API_BASE_URL.trimEnd('/') + url
            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(full))
            startActivity(intent)
        } catch (e: Exception) {
            toast("رابط الكشف: $url")
        }
    }
}
