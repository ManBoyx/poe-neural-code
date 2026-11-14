package io.github.manboyx.eclipse

import android.app.Application
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

class EclipseApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        installBouncyCastle()
    }

    companion object {
        /** Android embarque une version tronquée de BouncyCastle : on la remplace par la complète (Ed25519, ChaCha20…). */
        fun installBouncyCastle() {
            Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
            Security.insertProviderAt(BouncyCastleProvider(), 1)
        }
    }
}
