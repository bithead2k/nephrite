package dev.nephrite.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

class NoteWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
        val openToday = Intent(Intent.ACTION_VIEW, Uri.parse("nephrite://daily"), context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            0,
            openToday,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val capture = Intent(Intent.ACTION_VIEW, Uri.parse("nephrite://capture?location=Inbox"), context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val capturePending = PendingIntent.getActivity(
            context,
            1,
            capture,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        for (widgetId in widgetIds) {
            val views = RemoteViews(context.packageName, R.layout.note_widget).apply {
                setOnClickPendingIntent(R.id.note_widget_open, pending)
                setOnClickPendingIntent(R.id.note_widget_capture, capturePending)
            }
            manager.updateAppWidget(widgetId, views)
        }
    }
}
