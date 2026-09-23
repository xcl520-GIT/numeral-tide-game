// ============================================================
// 数值潮汐 · 桌面启动器（WebView2 原生窗口版）
//
// 这是一个真正独立的游戏窗口：有自己的标题栏、图标、尺寸，
// 不借用浏览器的界面。渲染内核用系统自带的 WebView2 运行时。
//
// 构建（无需安装任何开发工具，csc.exe 是 Windows 自带的）：
//   powershell -File tools\build.ps1
// ============================================================
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NumeralTide
{
    class GameWindow : Form
    {
        // 把本地文件夹映射成一个域名，这样页面有正常的 origin，
        // localStorage 之类的浏览器能力才能正常工作（file:// 下会被限制）。
        const string VirtualHost = "numeral-tide.local";

        WebView2 web;
        Label splash;

        [STAThread]
        static void Main()
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new GameWindow());
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "程序启动失败：\n" + ex.Message,
                    "数值潮汐", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        public GameWindow()
        {
            Text = "数值潮汐 · Numeral Tide";
            BackColor = Color.FromArgb(10, 14, 19);
            // 横向布局：左边是地图，右边是属性栏 + 装备 + 背包。
            // 竖屏窗口会让右侧面板被压扁，属性数字挤成两行，读起来很难受。
            ClientSize = new Size(1380, 880);
            // 高度下限可以放宽了：标题页的操作区在 style.css 里做成了
            // position: sticky bottom:0，无论窗口多矮，「开始下潜」都贴在可视区底部。
            // 这比"算一个刚好装下的最小高度"稳得多 —— 后者会在某个尺寸上失守，
            // 而失守的表现是玩家打开游戏却找不到开始按钮。
            MinimumSize = new Size(1120, 720);
            StartPosition = FormStartPosition.CenterScreen;

            splash = new Label();
            splash.Text = "正在唤醒潮汐…";
            splash.ForeColor = Color.FromArgb(120, 150, 175);
            splash.BackColor = BackColor;
            splash.Dock = DockStyle.Fill;
            splash.TextAlign = ContentAlignment.MiddleCenter;
            splash.Font = new Font("Microsoft YaHei UI", 12f);
            Controls.Add(splash);

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.Visible = false;
            Controls.Add(web);

            KeyPreview = true;
            KeyDown += OnKeyDown;
            Load += OnLoaded;
        }

        // F11 全屏。游戏里的 Esc 用来关弹窗，所以这里不抢 Esc。
        void OnKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F11)
            {
                FormBorderStyle = (FormBorderStyle == FormBorderStyle.None)
                    ? FormBorderStyle.Sizable
                    : FormBorderStyle.None;
                WindowState = (FormBorderStyle == FormBorderStyle.None)
                    ? FormWindowState.Maximized
                    : FormWindowState.Normal;
                e.Handled = true;
            }
        }

        async void OnLoaded(object sender, EventArgs e)
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string www = Path.Combine(baseDir, "www");

                if (!Directory.Exists(www))
                {
                    Fail("找不到 www 文件夹。\n\n预期位置：\n" + www);
                    return;
                }

                // 用户数据放在 LocalAppData，不污染游戏目录
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NumeralTide", "webview");
                Directory.CreateDirectory(userData);

                CoreWebView2Environment env =
                    await CoreWebView2Environment.CreateAsync(null, userData);
                await web.EnsureCoreWebView2Async(env);

                CoreWebView2Settings st = web.CoreWebView2.Settings;
                st.AreDefaultContextMenusEnabled = false;
                st.IsStatusBarEnabled = false;
                st.AreDevToolsEnabled = false;
                st.IsZoomControlEnabled = false;

                web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    VirtualHost, www, CoreWebView2HostResourceAccessKind.Allow);

                // 网页 → 宿主的消息通道。
                // 存在的唯一理由：**WebView2 里网页不能自己关窗**，
                // 所以菜单上的「退出游戏」只能发一条消息上来，由宿主 Close()。
                // 不做这件事的话，那个按钮在桌面版里看起来就是坏的。
                web.CoreWebView2.WebMessageReceived += OnWebMessage;

                web.CoreWebView2.Navigate("http://" + VirtualHost + "/index.html");

                web.Visible = true;
                splash.Visible = false;
            }
            catch (Exception ex)
            {
                Fail("初始化游戏窗口失败：\n" + ex.Message +
                     "\n\n本游戏依赖 Microsoft Edge WebView2 运行时，\n" +
                     "Windows 10 / 11 通常已自带；若缺失可从微软官网免费安装。");
            }
        }

        /** 网页发来的消息。目前只有一种：退出游戏。 */
        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                if (e.TryGetWebMessageAsString() == "quit") Close();
            }
            catch (Exception)
            {
                // 不是字符串消息（网页也可能 post 对象）—— 忽略，不要因此崩掉宿主
            }
        }

        void Fail(string msg)
        {
            MessageBox.Show(msg, "数值潮汐", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
