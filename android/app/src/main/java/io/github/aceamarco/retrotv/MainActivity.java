package io.github.aceamarco.retrotv;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** A full-screen WebView on the Retro TV page in TV mode, with the remote's keys forwarded to it. */
public class MainActivity extends Activity {
    private static final String OFFLINE_PAGE =
            "<body style='margin:0;height:100vh;display:grid;place-items:center;background:#000;"
            + "color:#7dff7a;font:700 28px Courier New,monospace;text-align:center'>"
            + "<div>NO SIGNAL<p style='font-size:16px;color:#6fae6d'>Can't reach Retro TV. "
            + "Check the network, then press OK to retry.</p></div></body>";

    private WebView web;
    private boolean offline;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);               // remembers the last channel
        settings.setMediaPlaybackRequiresUserGesture(false); // tune in with sound on launch
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                offline = true;
                view.loadDataWithBaseURL(null, OFFLINE_PAGE, "text/html", "utf-8", null);
            }
        });
        setContentView(web);
        web.loadUrl(BuildConfig.START_URL);
    }

    /** DOM key name for the remote buttons the page understands, or null to leave the key to the system. */
    private static String domKey(int keyCode) {
        if (keyCode >= KeyEvent.KEYCODE_0 && keyCode <= KeyEvent.KEYCODE_9) {
            return String.valueOf(keyCode - KeyEvent.KEYCODE_0);
        }
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP: return "ArrowUp";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "ArrowDown";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "ArrowLeft";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "ArrowRight";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER: return "Enter";
            case KeyEvent.KEYCODE_BACK: return "Back";
            case KeyEvent.KEYCODE_GUIDE:
            case KeyEvent.KEYCODE_MENU: return "Guide";
            case KeyEvent.KEYCODE_INFO: return "Info";
            case KeyEvent.KEYCODE_CHANNEL_UP: return "ChannelUp";
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return "ChannelDown";
            default: return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        final String key = domKey(event.getKeyCode());
        if (key == null) return super.dispatchKeyEvent(event);
        if (event.getAction() != KeyEvent.ACTION_DOWN) return true;

        if (offline) {
            if (key.equals("Enter")) {
                offline = false;
                web.loadUrl(BuildConfig.START_URL);
            } else if (key.equals("Back")) {
                finish();
            }
            return true;
        }
        // Back closes the guide if it is open; otherwise the page reports false and the app exits.
        web.evaluateJavascript("!!(window.retroTV && retroTV.key('" + key + "'))", handled -> {
            if (key.equals("Back") && !"true".equals(handled)) finish();
        });
        return true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
