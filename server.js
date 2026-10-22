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
    const result = await monitor.start(req.body);
    res.json(result || { success: true, message: 'Đã phát lệnh bắt đầu giám sát.' });
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
      const rawNodes = Array.from(document.querySelectorAll('.cart-item, [id^="item_"]'));
      const reasons = {
        total: rawNodes.length,
        shopOrHeader: 0,
        nestedChild: 0,
        recommendation: 0,
        disabledOrDeletedClass: 0,
        disabledParent: 0,
        outOfStockText: 0,
        noCheckbox: 0,
        checkboxDisabled: 0,
        noProductNameOrPrice: 0,
        validPassed: 0,
        sampleFiltered: []
      };

      rawNodes.forEach(node => {
        if (!node) return;
        if (node.classList.contains('checkout-shop') || node.classList.contains('list-header') || node.classList.contains('cart-item-list')) {
          reasons.shopOrHeader++;
          return;
        }
        if (rawNodes.some(other => other !== node && other.contains(node))) {
          reasons.nestedChild++;
          return;
        }
        if (node.closest('.recommend-list, .cart-recommend, [class*="recommend"], [class*="just-for-you"], [class*="similar"], [data-spm*="recommend"]')) {
          reasons.recommendation++;
          return;
        }
        if (node.classList.contains('cart-item-disabled') || node.classList.contains('item-del')) {
          reasons.disabledOrDeletedClass++;
          return;
        }
        if (node.closest('.cart-item-list-disabled, .disabled-items, [class*="unavailable"], [class*="disabled-item"]')) {
          reasons.disabledParent++;
          return;
        }
        const textContent = (node.innerText || node.textContent || '').toLowerCase();
        if (textContent.includes('sản phẩm này tạm thời hết hàng') ||
            textContent.includes('hết hàng') ||
            textContent.includes('hàng không có sẵn') ||
            textContent.includes('đã xóa') ||
            textContent.includes('ngừng kinh doanh')) {
          reasons.outOfStockText++;
          return;
        }
        const cbInput = node.querySelector('input[type="checkbox"]');
        const cbLabel = node.querySelector('.cart-item-checkbox, .next-checkbox');
        if (!cbInput && !cbLabel) {
          reasons.noCheckbox++;
          if (reasons.sampleFiltered.length < 3) {
            reasons.sampleFiltered.push({ reason: 'noCheckbox', id: node.id, cls: node.className, text: node.innerText?.slice(0, 100) });
          }
          return;
        }
        if (cbInput && (cbInput.disabled || cbInput.getAttribute('aria-disabled') === 'true')) {
          reasons.checkboxDisabled++;
          return;
        }
        if (cbLabel && cbLabel.classList.contains('disabled')) {
          reasons.checkboxDisabled++;
          return;
        }

        reasons.validPassed++;
      });

      return reasons;
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

// Endpoint chuyển tiếp thao tác kéo chuột (Drag) từ giao diện Web Dashboard vào trình duyệt Playwright (dùng để kéo thanh trượt chống bot)
app.post('/api/monitor/drag', async (req, res) => {
  try {
    const { startX, startY, endX, endY } = req.body;
    if (typeof startX !== 'number' || typeof startY !== 'number' || typeof endX !== 'number' || typeof endY !== 'number') {
      return res.status(400).json({ success: false, error: 'Tọa độ không hợp lệ' });
    }
    if (!monitor.page || monitor.page.isClosed()) {
      return res.status(400).json({ success: false, error: 'Trình duyệt chưa sẵn sàng' });
    }

    console.log(`[Monitor] 🖱️ Kéo chuột từ (${startX}, ${startY}) sang (${endX}, ${endY})`);
    await monitor.page.mouse.move(startX, startY);
    await monitor.page.waitForTimeout(60);
    await monitor.page.mouse.down();
    await monitor.page.waitForTimeout(60);

    const steps = 25;
    for (let i = 1; i <= steps; i++) {
      const cx = startX + (endX - startX) * (i / steps);
      const cy = startY + (endY - startY) * (i / steps) + (Math.sin(i / 2) * 2);
      await monitor.page.mouse.move(cx, cy);
      await monitor.page.waitForTimeout(12);
    }
    await monitor.page.mouse.up();
    await monitor.page.waitForTimeout(2000);

    const qrPath = path.join(__dirname, 'public', 'login-qr.png');
    await monitor.page.screenshot({ path: qrPath });

    res.json({ success: true, qrImage: '/login-qr.png?t=' + Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint tự động kéo thanh trượt chống bot
app.post('/api/monitor/solve-captcha', async (req, res) => {
  try {
    const solved = await monitor.handleCaptchaIfPresent();
    const qrPath = path.join(__dirname, 'public', 'login-qr.png');
    if (monitor.page && !monitor.page.isClosed()) {
      await monitor.page.screenshot({ path: qrPath });
    }
    res.json({ success: true, solved, qrImage: '/login-qr.png?t=' + Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint đưa cửa sổ trình duyệt Chromium ra trước màn hình
app.post('/api/monitor/bring-to-front', async (req, res) => {
  try {
    if (monitor.page && !monitor.page.isClosed()) {
      await monitor.page.bringToFront();
    }
    const { exec } = require('child_process');
    exec('powershell -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'Chromium\'); (New-Object -ComObject WScript.Shell).AppActivate(\'Lazada\')"', () => {});
    res.json({ success: true, message: 'Đã mở cửa sổ trình duyệt ra màn hình.' });
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
    const loggedIn = await monitor.checkIsLoggedIn();

    // Kiểm tra xem có popup chống bot đang hiển thị không
    const hasCaptcha = await monitor.page.evaluate(() => {
      const baxia = document.querySelector('#baxia-dialog-content, .baxia-dialog, div[class*="baxia"], div[id*="nocaptcha"]');
      const text = document.body ? document.body.innerText : '';
      return !!baxia || text.includes('Please drag the slider to verify') || text.includes('Please slide to verify');
    }).catch(() => false);

    let accountName = '';
    if (loggedIn) {
      accountName = await monitor.page.evaluate(() => {
        const el = document.querySelector('#myAccount, [data-spm*="my_account"], .account-info, [class*="member-name"], [class*="user-name"]');
        return el ? el.innerText.trim() : 'Tài khoản Lazada';
      }).catch(() => 'Tài khoản Lazada');
    }

    let qrImage = null;
    try {
      const qrPath = path.join(__dirname, 'public', 'login-qr.png');
      await monitor.page.screenshot({ path: qrPath });
      qrImage = '/login-qr.png?t=' + Date.now();
    } catch (e) {}

    // TUYỆT ĐỐI KHÔNG TỰ ĐỘNG GỌI handleLoginSuccess() Ở ĐÂY NỮA
    // Đăng nhập tách biệt hoàn toàn với bắt đầu chạy theo yêu cầu người dùng!

    res.json({
      loggedIn,
      accountName,
      hasCaptcha,
      currentUrl: curUrl,
      qrImage
    });
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
