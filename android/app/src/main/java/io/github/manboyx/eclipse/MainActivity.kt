package io.github.manboyx.eclipse

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.github.manboyx.eclipse.ui.AppServices
import io.github.manboyx.eclipse.ui.EclipseApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val services = AppServices(applicationContext)
        setContent { EclipseApp(services) }
    }
}
