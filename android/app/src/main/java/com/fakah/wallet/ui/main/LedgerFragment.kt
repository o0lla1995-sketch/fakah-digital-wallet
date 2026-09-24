package com.fakah.wallet.ui.main

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.os.Bundle
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.fakah.wallet.R
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

    // ── ledger rows (custom designed rows: icon + title + colored amount) ──
    private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
    private val rowFmt = SimpleDateFormat("MM-dd HH:mm", Locale.US)
    private data class RowUi(
        val title: String, val subtitle: String, val amount: String,
        val incoming: Boolean, val icon: Int, val iconBg: Int, val iconTint: Int
    )

    private fun displayTime(iso: String?): String = try {
        rowFmt.format(isoFmt.parse(iso ?: "") ?: Date(0))
    } catch (_: Exception) {
        (iso ?: "").take(16).replace('T', ' ')
    }

    private fun render() {
        val rows = items.map { e ->
            val incoming = e.direction != "debit"
            val sign = if (incoming) "+" else "-"
            val typeAr = when (e.type) {
                "qr_payment" -> "دفع QR"
                "fakka_deposit" -> "فكة رقمية"
                "p2p_transfer" -> "تحويل"
                else -> "صرف عملات"
            }
            val who = e.counterparty ?: ""
            val (icon, bg, tint) = when (e.type) {
                "qr_payment" -> Triple(R.drawable.ic_qr_scan, R.drawable.bg_circle_icon, R.color.primaryBright)
                "fakka_deposit" -> Triple(R.drawable.ic_fakka, R.drawable.bg_circle_icon_gold, R.color.accentGold)
                "p2p_transfer" -> Triple(R.drawable.ic_send, R.drawable.bg_circle_icon, R.color.primaryBright)
                else -> Triple(R.drawable.ic_convert, R.drawable.bg_circle_icon_blue, R.color.accentBlue)
            }
            RowUi(
                title = typeAr,
                subtitle = listOf(displayTime(e.occurredAt), who).filter { it.isNotBlank() }.joinToString(" · "),
                amount = "$sign${e.amount} ${e.currency}",
                incoming = incoming, icon = icon, iconBg = bg, iconTint = tint
            )
        }
        binding.lvLedger.adapter = object : ArrayAdapter<RowUi>(requireContext(), R.layout.item_ledger, rows) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val v = convertView ?: LayoutInflater.from(context).inflate(R.layout.item_ledger, parent, false)
                val r = getItem(position)!!
                val icon = v.findViewById<android.widget.ImageView>(R.id.rowIcon)
                icon.setImageResource(r.icon)
                v.findViewById<View>(R.id.rowIconBg).setBackgroundResource(r.iconBg)
                icon.setColorFilter(android.graphics.Color.parseColor(
                    if (r.iconTint == R.color.primaryBright) "#00D483"
                    else if (r.iconTint == R.color.accentGold) "#FFC85C"
                    else "#4C8DFF"
                ))
                v.findViewById<android.widget.TextView>(R.id.tvTitle).text = r.title
                v.findViewById<android.widget.TextView>(R.id.tvSubtitle).text = r.subtitle
                val amount = v.findViewById<android.widget.TextView>(R.id.tvAmount)
                amount.text = r.amount
                amount.setTextColor(android.graphics.Color.parseColor(if (r.incoming) "#00D483" else "#FF6B6B"))
                return v
            }
        }
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
