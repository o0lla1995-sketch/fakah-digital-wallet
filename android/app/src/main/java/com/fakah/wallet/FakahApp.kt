package com.fakah.wallet

import android.app.Application
import com.fakah.wallet.data.api.ApiClient

class FakahApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ApiClient.init(this)
    }
}
