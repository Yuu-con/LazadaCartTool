const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { loadConfig, saveConfig } = require('./src/config');
const { getLogs, clearLogs, exportCSV, updateLogAudioStatus, pruneLogs } = require('./src/logger');
const { sendTelegramMessage } = require('./src/telegram');
const LazadaPriceMonitor = require('./src/monitor');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Quản lý kết nối WebSocket Client
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);

  // Gửi trạng thái hiện tại khi client vừa kết nối
  ws.send(JSON.stringify({
    type: 'MONITOR_STATE',
    state: monitor.currentState,
    cycleCount: monitor.cycleCount,
    activeAlerts: monitor.activeAlerts,
    qrImage: monitor.currentState === 'WAITING_LOGIN' ? (`/login-qr.png?t=${Date.now()}`) : undefined
  }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// Khởi tạo Monitor Service
const monitor = new LazadaPriceMonitor((data) => {
  broadcast(data);
});

// API Routes

// 1. Cấu hình
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  try {
    const updated = saveConfig(req.body);
    broadcast({ type: 'CONFIG_UPDATED', config: updated });
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Điều khiển Monitor
app.post('/api/monitor/start', async (req, res) => {
  try {
    if (monitor.isRunning && monitor.currentState === 'WAITING_LOGIN') {
      const loggedIn = await monitor.checkIsLoggedIn();
      if (loggedIn) {
        monitor.handleLoginSuccess().catch(e => console.warn(e.message));
        return res.json({ success: true, message: 'Đã phát hiện đăng nhập và bắt đầu quét giỏ hàng.' });
      }
    }
    monitor.start(req.body);
    res.json({ success: true, message: 'Đã phát lệnh bắt đầu giám sát.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/monitor/stop', async (req, res) => {
  try {
    await monitor.stop();
    res.json({ success: true, message: 'Đã dừng giám sát.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint kích hoạt quét trích xuất giỏ hàng ngay lập tức
app.post('/api/monitor/scan-now', async (req, res) => {
  try {
    if (!monitor.page || monitor.page.isClosed()) {
      return res.status(400).json({ success: false, error: 'Trình duyệt chưa sẵn sàng' });
    }
    const curUrl = monitor.page.url();
    if (!curUrl.includes('/cart')) {
      await monitor.page.goto('https://cart.lazada.vn/cart', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await monitor.page.waitForTimeout(3000);
    }
    const items = await monitor.extractCartItems();
    res.json({ success: true, count: items.length, items: items.slice(0, 15) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/monitor/status', (req, res) => {
  res.json({
    state: monitor.currentState,
    cycleCount: monitor.cycleCount,
    isRunning: monitor.isRunning
  });
});

app.get('/api/monitor/debug', async (req, res) => {
  try {
    if (!monitor.page || monitor.page.isClosed()) {
      return res.json({ error: 'Page is not open or closed' });
    }
    const pagesList = monitor.browserContext ? monitor.browserContext.pages().map((p, idx) => ({ idx, url: p.url() })) : [];
    const currentUrl = monitor.page.url();
    const title = await monitor.page.title();
    const cookies = await monitor.browserContext ? await monitor.browserContext.cookies() : [];
    const lazadaCookies = cookies.filter(c => c.domain.includes('lazada')).map(c => ({ name: c.name, domain: c.domain }));

    // Chụp screenshot lưu vào thư mục public để xem trực quan
    const screenshotPath = path.join(__dirname, 'public', 'debug-screen.png');
    await monitor.page.screenshot({ path: screenshotPath });

    const htmlSnippet = await monitor.page.evaluate(() => {
      return {
        bodyTextSnippet: document.body ? document.body.innerText.slice(0, 1500) : '',
        cartItemsCount: document.querySelectorAll('.cart-item, [class*="cart-item"], .cart-item-list').length,
        hasLoginText: document.body ? document.body.innerText.includes('Đăng nhập / Đăng ký') : false,
        allDivClasses: Array.from(document.querySelectorAll('div[class]')).slice(0, 30).map(d => d.className),
        inputValues: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, val: i.value, name: i.name }))
      };
    });
    res.json({ currentUrl, title, pagesList, lazadaCookiesCount: lazadaCookies.length, lazadaCookies, ...htmlSnippet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/monitor/inspect-cart', async (req, res) => {
  try {
    if (!monitor.page || monitor.page.isClosed()) {
      return res.status(400).json({ error: 'Page not open' });
    }
    const info = await monitor.page.evaluate(() => {
      // 1. Inspect first cart item
      const firstItem = document.querySelector('.cart-item, [id^="item_"]');
      let itemInfo = null;
      if (firstItem) {
        const checkboxes = Array.from(firstItem.querySelectorAll('input[type="checkbox"], .next-checkbox, label'));
        itemInfo = {
          id: firstItem.id,
          className: firstItem.className,
          outerHtmlPrefix: firstItem.outerHTML.slice(0, 500),
          checkboxes: checkboxes.map(cb => ({
            tag: cb.tagName,
            type: cb.type,
            className: cb.className,
            checked: cb.checked,
            outerHTML: cb.outerHTML.slice(0, 200)
          }))
        };
      }

      // 2. Inspect Select All
      const selectAllEl = Array.from(document.querySelectorAll('*')).find(el => (el.innerText || '').includes('CHỌN TẤT CẢ') || (el.innerText || '').includes('Chọn tất cả'));
      let selectAllInfo = null;
      if (selectAllEl) {
        const parent = selectAllEl.closest('div') || selectAllEl;
        const cb = parent.querySelector('input[type="checkbox"], .next-checkbox');
        selectAllInfo = {
          text: selectAllEl.innerText,
          parentHtml: parent.outerHTML.slice(0, 300),
          cbInfo: cb ? { tag: cb.tagName, className: cb.className, checked: cb.checked, outerHTML: cb.outerHTML.slice(0, 200) } : null
        };
      }

      // 3. Inspect Checkout Button
      const checkoutButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return t.includes('THANH TOÁN') || t.includes('Thanh toán') || t.includes('Đặt hàng');
      });

      const buttonsInfo = checkoutButtons.map(btn => ({
        tag: btn.tagName,
        className: btn.className,
        text: btn.innerText.trim(),
        disabled: btn.disabled || btn.getAttribute('disabled'),
        outerHTML: btn.outerHTML.slice(0, 250)
      }));

      return { itemInfo, selectAllInfo, buttonsInfo };
    });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitor/test-select-item', async (req, res) => {
  try {
    if (!monitor.page || monitor.page.isClosed()) {
      return res.status(400).json({ error: 'Page not open' });
    }
    // Find the first cart item's checkbox using Playwright locator
    const itemLocator = monitor.page.locator('.cart-item, [id^="item_"]').first();
    const checkboxLocator = itemLocator.locator('.cart-item-checkbox, label.next-checkbox, input[type="checkbox"]').first();

    // Scroll into view
    await checkboxLocator.scrollIntoViewIfNeeded();
    await monitor.page.waitForTimeout(500);

    // Playwright trusted click
    await checkboxLocator.click();
    await monitor.page.waitForTimeout(2000);

    const checkoutBtn = monitor.page.locator('.checkout-order-total-button, button.automation-checkout-order-total-button-button').first();
    const btnTextChecked = await checkoutBtn.innerText();

    // Click again to uncheck (restore clean state)
    await checkboxLocator.click();
    await monitor.page.waitForTimeout(1500);
    const btnTextUnchecked = await checkoutBtn.innerText();

    res.json({
      success: true,
      btnTextChecked,
      btnTextUnchecked
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Endpoint kích hoạt tự động đặt hàng (Auto Checkout)
app.post('/api/monitor/auto-order', async (req, res) => {
  try {
    const { targetItem } = req.body;
    const config = loadConfig();
    const threshold = config.priceThreshold || 550000;
    let itemToOrder = targetItem;
    if (!itemToOrder) {
      const items = await monitor.extractCartItems();
      itemToOrder = items.find(it => it.currentPrice !== null && it.currentPrice < threshold) || items[0];
    }
    if (!itemToOrder) {
      return res.status(400).json({ success: false, error: 'Không tìm thấy sản phẩm nào để đặt hàng' });
    }
    monitor.performAutoOrder(itemToOrder, threshold, config).catch(e => console.error('[AutoOrder] Lỗi:', e.message));
    res.json({ success: true, message: `Đã kích hoạt đặt hàng tự động cho: ${itemToOrder.productName}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// Endpoint chuyển trang sang Đăng nhập Lazada và chụp QR
app.post('/api/monitor/open-login', async (req, res) => {
  try {
    const result = await monitor.openLoginPageAndPrepareQr();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint chuyển tiếp cú nhấp chuột từ giao diện Web Dashboard vào trình duyệt Playwright
app.post('/api/monitor/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    if (typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ success: false, error: 'Tọa độ không hợp lệ' });
    }
    if (!monitor.page || monitor.page.isClosed()) {
      return res.status(400).json({ success: false, error: 'Trình duyệt chưa sẵn sàng' });
    }

    console.log(`[Monitor] Nhận cú click từ dashboard tại tọa độ (${x}, ${y})`);
    await monitor.page.mouse.click(x, y);
    await monitor.page.waitForTimeout(1000);

    const qrPath = path.join(__dirname, 'public', 'login-qr.png');
    await monitor.page.screenshot({ path: qrPath });

    res.json({ success: true, qrImage: '/login-qr.png?t=' + Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint kiểm tra xem đã đăng nhập thành công chưa
app.get('/api/monitor/check-login', async (req, res) => {
  try {
    if (!monitor.page || monitor.page.isClosed()) {
      return res.json({ loggedIn: false });
    }
    const curUrl = monitor.page.url();
    const userInfo = await monitor.page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const cartItemsCount = document.querySelectorAll('.cart-item, [class*="cart-item"], .cart-item-list').length;
      const hasSelectAll = text.includes('CHỌN TẤT CẢ') || text.includes('Chọn tất cả');
      const hasAccount = !!document.querySelector('#myAccount, [data-spm*="my_account"], .account-info, [class*="member-name"]') ||
                          text.includes('TÀI KHOẢN') || text.includes('Xin chào') || text.includes('Quản lý tài khoản');
      const isStillLogin = text.includes('Đăng nhập / Đăng ký') && text.includes('Bạn chưa thêm sản phẩm');
      return { cartItemsCount, hasSelectAll, hasAccount, isStillLogin };
    });

    let hasAuthCookie = false;
    try {
      if (monitor.browserContext) {
        const cookies = await monitor.browserContext.cookies();
        hasAuthCookie = cookies.some(c => c.domain.includes('lazada') && (
          c.name === 'lzd_sid' || c.name === 'x5sec' || c.name === 'user_id' || c.name === 'uc4' || c.name === 'cookie2'
        ));
      }
    } catch (e) {}

    const isCartOrHome = (curUrl.includes('/cart') || curUrl.includes('lazada.vn')) && !curUrl.includes('member/login') && !curUrl.includes('login.lazada.vn');
    const loggedIn = userInfo.cartItemsCount > 0 || userInfo.hasSelectAll || userInfo.hasAccount || (hasAuthCookie && !curUrl.includes('member/login')) || (isCartOrHome && !userInfo.isStillLogin);

    // Nếu phát hiện đã đăng nhập thành công: tự động chuyển về giỏ hàng và kích hoạt quét
    if (loggedIn) {
      if (monitor.currentState === 'WAITING_LOGIN' || !curUrl.includes('/cart')) {
        monitor.handleLoginSuccess().catch(e => console.warn('[Monitor] Lỗi handleLoginSuccess:', e.message));
      }
    }

    res.json({ loggedIn, currentUrl: curUrl, userInfo });
  } catch (err) {
    res.status(500).json({ loggedIn: false, error: err.message });
  }
});

// Endpoint đồng bộ Cookie từ trình duyệt bên ngoài vào bot
app.post('/api/cookie/sync', async (req, res) => {
  try {
    const rawCookie = req.body.cookie || req.body.cookies;
    if (!rawCookie || typeof rawCookie !== 'string') {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp chuỗi cookie hợp lệ' });
    }

    if (!monitor.browserContext) {
      await monitor.start();
    }

    const cookiesToAdd = [];
    if (rawCookie.trim().startsWith('[') || rawCookie.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawCookie);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of list) {
          cookiesToAdd.push({
            name: c.name,
            value: c.value,
            domain: c.domain || '.lazada.vn',
            path: c.path || '/'
          });
        }
      } catch (e) {}
    }

    if (cookiesToAdd.length === 0) {
      const pairs = rawCookie.split(';');
      for (const pair of pairs) {
        const idx = pair.indexOf('=');
        if (idx > -1) {
          const name = pair.slice(0, idx).trim();
          const value = pair.slice(idx + 1).trim();
          if (name) {
            cookiesToAdd.push({
              name: name,
              value: value,
              domain: '.lazada.vn',
              path: '/'
            });
          }
        }
      }
    }

    if (cookiesToAdd.length === 0) {
      return res.status(400).json({ success: false, error: 'Không tìm thấy cookie nào để đồng bộ' });
    }

    await monitor.browserContext.addCookies(cookiesToAdd);

    if (monitor.page && !monitor.page.isClosed()) {
      const config = loadConfig();
      const targetCartUrl = (config.cartUrl && config.cartUrl.trim()) ? config.cartUrl.trim() : LAZADA_CART_URL;
      await monitor.page.goto(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await monitor.page.waitForTimeout(2000);
    }

    res.json({ success: true, count: cookiesToAdd.length, message: `Đã đồng bộ ${cookiesToAdd.length} cookie thành công!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Nhật ký và Lịch sử
app.get('/api/logs', (req, res) => {
  const { status, productName, fromTime, toTime } = req.query;
  const logs = getLogs({ status, productName, fromTime, toTime });
  res.json(logs);
});

app.delete('/api/logs', (req, res) => {
  const ok = clearLogs();
  if (ok) {
    broadcast({ type: 'LOGS_CLEARED' });
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: 'Không thể xóa log' });
  }
});

// Endpoint tự động xóa bớt log cũ
app.post('/api/logs/auto-clean', (req, res) => {
  try {
    const result = pruneLogs(req.body);
    broadcast({ type: 'LOGS_CLEANED', ...result });
    res.json({
      success: true,
      deletedCount: result.deletedCount,
      remainingCount: result.remainingCount,
      message: `Đã dọn dẹp ${result.deletedCount} log cũ. Còn lại ${result.remainingCount} bản ghi.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/logs/export/csv', (req, res) => {
  const csv = exportCSV();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=lazada_price_history.csv');
  res.send(csv);
});

app.get('/api/logs/export/json', (req, res) => {
  const logs = getLogs();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=lazada_price_history.json');
  res.send(JSON.stringify(logs, null, 2));
});

// 4. Trạng thái âm thanh từ client
app.post('/api/audio-status', (req, res) => {
  const { status, logId } = req.body;
  if (logId) {
    updateLogAudioStatus(logId, status);
  }
  res.json({ success: true });
});

// 5. Thử nghiệm thông báo Telegram
app.post('/api/telegram/test', async (req, res) => {
  const { botToken, chatId } = req.body;
  const token = botToken || loadConfig().telegram?.botToken;
  const chat = chatId || loadConfig().telegram?.chatId;

  if (!token || !chat) {
    return res.status(400).json({
      success: false,
      error: 'Vui lòng cung cấp Bot Token và Chat ID để kiểm tra!'
    });
  }

  const timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const testMsg = `🔔 <b>KIỂM TRA KẾT NỐI TELEGRAM THÀNH CÔNG!</b>\n\n` +
    `Ứng dụng <b>Lazada Cart Price Monitor</b> đã kết nối thành công với điện thoại Android của bạn.\n` +
    `⏰ Thời gian: ${timeStr}\n` +
    `Bạn sẽ nhận được thông báo đẩy tức thì mỗi khi sản phẩm trong giỏ hàng hạ giá dưới ngưỡng quy định.`;

  const result = await sendTelegramMessage(token, chat, testMsg);
  res.json(result);
});

// Start Server
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 LAZADA CART PRICE MONITOR SERVER ĐANG CHẠY!`);
  console.log(`🌐 Mở bảng điều khiển tại: http://localhost:${PORT}`);
  console.log(`====================================================`);
  // Tự động kiểm tra và dọn dẹp bớt log cũ khi khởi động máy chủ
  pruneLogs();
});
