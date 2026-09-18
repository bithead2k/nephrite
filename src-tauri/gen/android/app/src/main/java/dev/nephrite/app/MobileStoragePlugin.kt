package dev.nephrite.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject

@TauriPlugin
class MobileStoragePlugin(private val activity: Activity) : Plugin(activity) {
    private fun granted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

    private fun state(): JSObject = JSObject().apply { put("granted", granted()) }

    @Command
    fun status(invoke: Invoke) {
        invoke.resolve(state())
    }

    @Command
    fun request(invoke: Invoke) {
        if (!granted()) {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                data = Uri.parse("package:${activity.packageName}")
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(intent)
                } catch (_: Exception) {
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                }
            }
        }
        invoke.resolve(state())
    }
}
