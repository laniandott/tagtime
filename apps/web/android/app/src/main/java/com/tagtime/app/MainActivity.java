package com.tagtime.app;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 让系统自动把 WebView 放在状态栏和导航栏之外，避免重复叠加顶部 inset。
        // Android 15 上是否生效由 styles.xml 中的 opt-out 属性决定。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge == null ? null : bridge.getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }

                finish();
            }
        });
    }
}
