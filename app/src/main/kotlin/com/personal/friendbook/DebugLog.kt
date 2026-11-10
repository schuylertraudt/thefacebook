package com.personal.friendbook

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** In-memory discovery log. Never written to disk. */
object DebugLog {
    private const val MAX_LINES = 3000
    private val lines = ArrayDeque<String>()
    private val main = Handler(Looper.getMainLooper())
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    /** Called on the main thread with each new line. */
    var listener: ((String) -> Unit)? = null

    fun add(tag: String, msg: String) {
        val line = synchronized(this) {
            val l = "${fmt.format(Date())} [$tag] $msg"
            lines.addLast(l)
            while (lines.size > MAX_LINES) lines.removeFirst()
            l
        }
        main.post { listener?.invoke(line) }
    }

    fun text(): String = synchronized(this) { lines.joinToString("\n") }

    fun clear() = synchronized(this) { lines.clear() }
}
