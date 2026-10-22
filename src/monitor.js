const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { parseVNDPrice, evaluatePriceStatus } = require('./price-parser');
const { addLogEntry, addLogEntries, updateLogAudioStatus, updateLogTelegramStatus } = require('./logger');
const { sendTelegramMessage, formatProductAlertMessage, formatBatchAlertMessage, formatOrderSuccessMessage } = require('./telegram');
const { loadConfig } = require('./config');

const LAZADA_CART_URL = 'https://cart.lazada.vn/cart';
const USER_DATA_DIR = path.join(__dirname, '..', 'data', 'browser-profile');

class LazadaPriceMonitor {
  constructor(ioEmitter) {
    this.ioEmitter = ioEmitter; // Callback / WebSocket broadcast tới Web Dashboard
    this.browserContext = null;
    this.page = null;
    this.isRunning = false;
    this.isStopping = false;
    this.cycleTimer = null;
    this.cycleCount = 0;
    this.currentState = 'STOPPED'; // 'RUNNING' | 'STOPPED' | 'RELOADING' | 'ERROR' | 'WAITING_LOGIN'
    this.lastProductPrices = new Map(); // Map: productName/ID -> lastPrice
    this.lastAlertedPrices = new Map(); // Map: productKey -> lastAlertedPrice
    this.orderedProductKeys = new Set(); // Set các sản phẩm đã được tự động đặt hàng để không mua lặp lại
    this.isOrdering = false; // Trạng thái đang tiến hành chuỗi đặt hàng tự động
    this.lastCheckedThreshold = null; // Theo dõi ngưỡng cảnh báo hiện tại
    this.activeAlerts = []; // Danh sách sản phẩm đang trong cảnh báo chu kỳ này
    this.retryCount = 0;
    this.browserInitPromise = null;
    this.navigationPromise = null;
    this.lastSummaryLoggedCycle = null;
    this.isTransitioningToCart = false;
    this.isLoginErrorLogged = false;
  }

  emitState(extra = {}) {
    if (this.ioEmitter) {
      this.ioEmitter({
        type: 'MONITOR_STATE',
        state: this.currentState,
        cycleCount: this.cycleCount,
        activeAlerts: this.activeAlerts,
        ...extra
      });
    }
  }

  async ensureBrowser() {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    if (this.browserInitPromise) {
      return this.browserInitPromise;
    }

    this.browserInitPromise = (async () => {
      try {
        if (!fs.existsSync(USER_DATA_DIR)) {
          fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        }

        let needLaunch = true;
        if (this.browserContext) {
          try {
            const testPages = this.browserContext.pages();
            if (testPages && testPages.length > 0) {
              needLaunch = false;
              this.page = testPages[0];
            }
          } catch (e) {
            needLaunch = true;
            this.browserContext = null;
          }
        }

        if (needLaunch) {
          const launchOptions = {
            headless: false,
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ignoreDefaultArgs: ['--enable-automation'],
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-default-browser-check',
              '--start-maximized'
            ]
          };

          this.browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
          await this.browserContext.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
              get: () => undefined
            });
            window.chrome = {
              runtime: {},
              loadTimes: function() {},
              csi: function() {},
              app: {}
            };
          });

          const pages = this.browserContext.pages();
          this.page = pages.length > 0 ? pages[0] : await this.browserContext.newPage();
        }
        return this.page;
      } finally {
        this.browserInitPromise = null;
      }
    })();

    return this.browserInitPromise;
  }

  async safeNavigate(url, options = { waitUntil: 'domcontentloaded', timeout: 35000 }) {
    if (this.navigationPromise) {
      try {
        await this.navigationPromise;
      } catch (e) {}
    }
    this.navigationPromise = (async () => {
      if (this.page && !this.page.isClosed()) {
        const curUrl = this.page.url();
        if (curUrl !== url) {
          await this.page.goto(url, options);
        }
      }
    })();
    try {
      await this.navigationPromise;
    } finally {
      this.navigationPromise = null;
    }
  }

  async checkIsLoggedIn() {
    if (!this.page || this.page.isClosed()) return false;
    try {
      const curUrl = this.page.url();
      // Nếu đang ở URL login hoặc punish/captcha -> Chắc chắn chưa đăng nhập
      if (curUrl.includes('member/login') || curUrl.includes('login.lazada.vn') || curUrl.includes('punish') || curUrl.includes('_____tmd_____')) {
        return false;
      }

      // Đợi tối đa 2.5s để header Lazada hydrate đầy đủ
      for (let i = 0; i < 5; i++) {
        const pageInfo = await this.page.evaluate(() => {
          const text = document.body ? document.body.innerText : '';
          const header = document.querySelector('.top-header, #topActionUser, [class*="header"], header') || document.body;
          const headerText = header ? header.innerText : '';

          // 1. Dấu hiệu chắc chắn đã đăng nhập:
          const accountEl = document.querySelector('#myAccount, [data-spm*="my_account"], .account-info, [class*="member-name"], [class*="user-name"], .top-account');
          const hasAccountText = headerText.includes('TÀI KHOẢN') || headerText.includes('Xin chào') || headerText.includes('Quản lý tài khoản') || text.includes('TÀI KHOẢN CỦA TÔI');
          if (accountEl || hasAccountText) {
            return {
              isLoggedIn: true,
              accountName: accountEl ? accountEl.innerText.trim() : 'Tài khoản Lazada'
            };
          }

          // 2. Dấu hiệu chắc chắn chưa đăng nhập (Guest):
          const hasLoginLink = !!document.querySelector('a[href*="member.lazada.vn/user/login"], a[href*="login.lazada.vn"], [data-spm*="dlogin"], a[href*="/user/signup"]');
          const hasLoginText = (headerText.includes('ĐĂNG NHẬP') && headerText.includes('ĐĂNG KÝ')) ||
                               (headerText.includes('LOGIN') && headerText.includes('SIGNUP'));
          if (hasLoginLink || hasLoginText) {
            return { isLoggedIn: false, reason: 'Có nút Đăng nhập / Đăng ký trên thanh tiêu đề' };
          }

          return null; // Chưa hydrate xong
        });

        if (pageInfo !== null) {
          return pageInfo.isLoggedIn;
        }

        await this.page.waitForTimeout(400);
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  async handleLoginSuccess() {
    if (this.isTransitioningToCart) {
      return;
    }
    this.isTransitioningToCart = true;

    try {
      console.log('[Monitor] 🎉 Xác nhận đăng nhập thành công! Đang đồng bộ trạng thái...');
      this.isLoginErrorLogged = false;

      const config = loadConfig();
      const targetCartUrl = (config.cartUrl && config.cartUrl.trim()) ? config.cartUrl.trim() : LAZADA_CART_URL;

      this.emitState({
        type: 'LOGIN_CONFIRMED',
        message: '🎉 Đăng nhập thành công! Bạn có thể bắt đầu giám sát bất kỳ lúc nào.'
      });

      if (this.page && !this.page.isClosed()) {
        const curUrl = this.page.url();
        if (!curUrl.includes('/cart')) {
          console.log('[Monitor] Điều hướng về trang giỏ hàng:', targetCartUrl);
          await this.safeNavigate(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        }
      }
    } catch (err) {
      console.error('[Monitor] Lỗi khi chuyển về giỏ hàng sau đăng nhập:', err.message);
    } finally {
      this.isTransitioningToCart = false;
    }
  }

  async start(options = {}) {
    if (this.isRunning && this.currentState !== 'WAITING_LOGIN' && this.currentState !== 'ERROR') {
      console.log('[Monitor] Tiến trình giám sát đã đang chạy.');
      return { success: true, message: 'Tiến trình giám sát đã đang chạy.' };
    }

    try {
      await this.ensureBrowser();

      if (options && options.openLogin) {
        return await this.openLoginPageAndPrepareQr();
      }

      const config = loadConfig();
      const targetCartUrl = (config.cartUrl && config.cartUrl.trim()) ? config.cartUrl.trim() : LAZADA_CART_URL;

      // Đảm bảo trình duyệt đang ở trang Lazada trước khi kiểm tra phiên đăng nhập
      if (this.page && !this.page.isClosed()) {
        const curUrl = this.page.url();
        if (!curUrl.includes('lazada.vn')) {
          console.log('[Monitor] Điều hướng tới trang giỏ hàng để kiểm tra phiên đăng nhập:', targetCartUrl);
          await this.safeNavigate(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        }
      }

      // BẮT BUỘC KIỂM TRA ĐĂNG NHẬP TRƯỚC KHI CHẠY GIÁM SÁT:
      // Tách biệt hoàn toàn việc đăng nhập với quét: Nếu chưa đăng nhập thì KHÔNG ĐƯỢC CHẠY
      const loggedIn = await this.checkIsLoggedIn();
      if (!loggedIn) {
        console.log('[Monitor] ⚠️ Chưa đăng nhập! Yêu cầu đăng nhập trước khi bắt đầu giám sát.');
        this.isRunning = false;
        this.isLoginMode = true;
        this.currentState = 'WAITING_LOGIN';
        await this.openLoginPageAndPrepareQr();
        return {
          success: false,
          isLoginNeeded: true,
          message: 'Bạn chưa đăng nhập tài khoản Lazada. Vui lòng quét mã QR hoặc đăng nhập trước khi bắt đầu giám sát.'
        };
      }

      // Đã xác nhận đăng nhập thực sự -> Kích hoạt chạy giám sát
      this.isLoginMode = false;
      this.isRunning = true;
      this.isStopping = false;
      this.retryCount = 0;
      this.currentState = 'RUNNING';
      this.emitState({ state: 'RUNNING', message: 'Đã xác nhận đăng nhập. Bắt đầu chu kỳ giám sát giỏ hàng...' });


      if (this.page && !this.page.isClosed()) {
        const curUrl = this.page.url();
        if (!curUrl.includes('/cart')) {
          this.currentState = 'NAVIGATING';
          this.emitState({ message: `Đang mở trang giỏ hàng Lazada: ${targetCartUrl}` });
          await this.safeNavigate(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        }
      }

      this.runCycle();
      return { success: true, message: 'Đã bắt đầu giám sát giỏ hàng.' };
    } catch (err) {
      console.error('[Monitor] Lỗi khởi động giám sát:', err);
      this.currentState = 'ERROR';
      this.isRunning = false;
      this.emitState({ message: `Lỗi khởi động: ${err.message}` });
      return { success: false, error: err.message };
    }
  }

  async stop() {
    console.log('[Monitor] Nhận lệnh dừng giám sát.');
    this.isStopping = true;
    this.isRunning = false;

    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }

    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch (e) {
        console.warn('[Monitor] Lỗi đóng browserContext:', e.message);
      }
      this.browserContext = null;
      this.page = null;
    }

    this.currentState = 'STOPPED';
    this.emitState({ message: 'Đã dừng giám sát giỏ hàng.' });
  }

  async runCycle() {
    if (!this.isRunning || this.isStopping) return;

    this.cycleCount++;
    this.currentState = 'RUNNING';
    const config = loadConfig();
    const threshold = config.priceThreshold || 550000;

    const targetCartUrl = (config.cartUrl && config.cartUrl.trim()) ? config.cartUrl.trim() : LAZADA_CART_URL;

    // Yêu cầu: Trước khi quét giỏ hàng, reload page để làm mới trạng thái và quét ngay tức thì
    this.emitState({
      message: `Chu kỳ #${this.cycleCount}: Đang làm mới giỏ hàng (Pre-scan Reload)...`
    });

    try {
      // 1. LÀM MỚI TRẠNG THÁI (Pre-scan Reload): Bắt buộc reload lại giỏ hàng trước mỗi chu kỳ quét
      if (this.page && !this.page.isClosed()) {
        const curUrl = this.page.url();
        if (curUrl.includes('/cart') && !curUrl.includes('punish')) {
          console.log(`[Monitor] ⚡ Chu kỳ #${this.cycleCount}: Reload giỏ hàng để đồng bộ dữ liệu mới nhất...`);
          await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => {
            console.warn('[Monitor] Cảnh báo reload giỏ hàng:', e.message);
          });
        } else {
          console.log(`[Monitor] Điều hướng về giỏ hàng: ${targetCartUrl}`);
          await this.safeNavigate(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
      }

      // Kiểm tra và giải Slide CAPTCHA ngay lập tức nếu xuất hiện
      await this.handleCaptchaIfPresent();

      // 2. Kiểm tra trạng thái đăng nhập và xác nhận giỏ hàng đã sẵn sàng
      const statusCheck = await this.verifyCartPage();
      if (!statusCheck.ready) {
        this.currentState = statusCheck.isLoginNeeded ? 'WAITING_LOGIN' : 'ERROR';

        if (statusCheck.isLoginNeeded) {
          console.log('[Monitor] Phát hiện chưa đăng nhập! Đang chuẩn bị trang đăng nhập Lazada và mã QR...');

          if (!this.isLoginErrorLogged) {
            this.isLoginErrorLogged = true;
            addLogEntry({
              cycleId: this.cycleCount,
              productName: 'Hệ thống giỏ hàng',
              threshold: threshold,
              status: 'ERROR',
              errorMessage: 'Trình duyệt chưa đăng nhập tài khoản Lazada. Vui lòng quét mã QR để tiếp tục.'
            });
          }

          const curUrl = this.page ? this.page.url() : '';
          const isAlreadyOnLogin = curUrl.includes('member/login') || curUrl.includes('login.lazada.vn');
          if (!isAlreadyOnLogin) {
            await this.openLoginPageAndPrepareQr();
          } else {
            try {
              const qrPath = path.join(__dirname, '..', 'public', 'login-qr.png');
              await this.page.screenshot({ path: qrPath });
              this.emitState({
                type: 'LOGIN_REQUIRED',
                state: 'WAITING_LOGIN',
                qrImage: '/login-qr.png?t=' + Date.now(),
                message: '📱 Đang chờ quét mã QR để đăng nhập Lazada...'
              });
            } catch (e) {}
          }

          this.scheduleNextCycle(10);
          return;
        }

        this.emitState({ message: statusCheck.message });

        addLogEntry({
          cycleId: this.cycleCount,
          productName: 'Hệ thống giỏ hàng',
          threshold: threshold,
          status: 'ERROR',
          errorMessage: statusCheck.message
        });

        this.scheduleNextCycle(config.checkIntervalSeconds || 10);
        return;
      }

      // Đã sẵn sàng -> Reset cờ lỗi đăng nhập
      this.isLoginErrorLogged = false;

      // 3. Trích xuất toàn bộ sản phẩm hợp lệ trong giỏ hàng NGAY SAU KHI VỪA RELOAD
      const scannedItems = await this.extractCartItems();

      if (scannedItems.length === 0) {
        this.emitState({
          scannedCount: 0,
          alertCount: 0,
          message: `Chu kỳ #${this.cycleCount}: Giỏ hàng hiện tại trống (0 sản phẩm).`
        });
        addLogEntry({
          cycleId: this.cycleCount,
          productName: 'Hệ thống giỏ hàng',
          threshold: threshold,
          status: 'NORMAL',
          errorMessage: 'Giỏ hàng đang trống hoặc không có sản phẩm nào khả dụng.'
        });
      } else {
        // 4. Phân tích giá từng sản phẩm so với ngưỡng
        const newAlertItems = [];
        const currentCycleAlerts = [];
        const logEntriesToSave = [];

        const currentThreshold = Number(threshold);
        if (this.lastCheckedThreshold !== currentThreshold) {
          console.log(`[Monitor] Ngưỡng cảnh báo thay đổi: ${this.lastCheckedThreshold} -> ${currentThreshold}. Làm mới danh sách cảnh báo.`);
          this.lastCheckedThreshold = currentThreshold;
          this.lastAlertedPrices.clear();
        }

        for (const item of scannedItems) {
          if (item.currentPrice !== null) {
            this.lastProductPrices.set(item.productKey, item.currentPrice);
          }

          if (item.currentPrice !== null && item.currentPrice < threshold) {
            const lastAlertedPrice = this.lastAlertedPrices.get(item.productKey);
            let isNewAlert = false;

            if (lastAlertedPrice === undefined || lastAlertedPrice === null) {
              isNewAlert = true;
            } else if (item.currentPrice < lastAlertedPrice) {
              isNewAlert = true;
            } else if (config.repeatAlertOnSameLowPrice) {
              isNewAlert = true;
            }

            if (isNewAlert) {
              this.lastAlertedPrices.set(item.productKey, item.currentPrice);
            }

            logEntriesToSave.push({
              cycleId: this.cycleCount,
              productName: item.productName,
              productUrl: item.productUrl,
              currentPrice: item.currentPrice,
              quantity: item.quantity,
              threshold: threshold,
              status: 'ALERT',
              isNewAlert: isNewAlert,
              audioStatus: isNewAlert ? 'PLAYING' : 'N/A',
              telegramStatus: (config.telegram?.enabled && isNewAlert) ? 'PENDING' : (config.telegram?.enabled ? 'ALREADY_SENT' : 'DISABLED'),
              errorMessage: ''
            });

            currentCycleAlerts.push({
              ...item,
              isNewAlert: isNewAlert,
              alertTime: new Date().toISOString()
            });

            if (isNewAlert) {
              newAlertItems.push(item);
            }
          } else if (item.currentPrice !== null && item.currentPrice >= threshold) {
            this.lastAlertedPrices.delete(item.productKey);
          }
        }

        if (currentCycleAlerts.length === 0) {
          if (this.lastSummaryLoggedCycle !== this.cycleCount) {
            this.lastSummaryLoggedCycle = this.cycleCount;
            logEntriesToSave.push({
              cycleId: this.cycleCount,
              productName: 'Tổng kết chu kỳ',
              productUrl: '',
              currentPrice: null,
              quantity: scannedItems.length,
              threshold: threshold,
              status: 'SUCCESS',
              isNewAlert: false,
              audioStatus: '—',
              telegramStatus: '—',
              errorMessage: `Đã kiểm tra ${scannedItems.length} sản phẩm, không có sản phẩm nào đạt ngưỡng cảnh báo.`
            });
          }
        }

        if (logEntriesToSave.length > 0) {
          const savedLogs = addLogEntries(logEntriesToSave);
          currentCycleAlerts.forEach(alert => {
            const matchedLog = savedLogs.find(l => l.productName === alert.productName);
            if (matchedLog) alert.logId = matchedLog.id;
          });
        }

        this.activeAlerts = currentCycleAlerts;
        this.emitState({
          scannedCount: scannedItems.length,
          alertCount: currentCycleAlerts.length,
          message: currentCycleAlerts.length > 0
            ? `Chu kỳ #${this.cycleCount}: Phát hiện ${currentCycleAlerts.length} sản phẩm giá thấp!`
            : `Kiểm tra thành công – Chu kỳ #${this.cycleCount} (${scannedItems.length} sản phẩm, không có giá thấp).`
        });

        // 5. Phát cảnh báo Web Audio & Telegram (chạy nền bất đồng bộ, KHÔNG làm trễ tiến trình đặt hàng)
        if (newAlertItems.length > 0) {
          this.emitState({
            type: 'TRIGGER_ALERT',
            newAlertItems: newAlertItems,
            allAlerts: currentCycleAlerts
          });
          this.sendTelegramAlerts(config, newAlertItems, threshold).catch(e => {
            console.error('[Monitor] Lỗi gửi tin Telegram cảnh báo:', e.message);
          });
        }

        // 6. Yêu cầu quan trọng: "khi phát hiện sản phẩm phải đảm bảo đặt hàng ngay lúc quét xong tất cả sản phẩm"
        if (config.autoOrder !== false && currentCycleAlerts.length > 0) {
          const unpurchasedItems = currentCycleAlerts.filter(item => !this.orderedProductKeys.has(item.productKey));
          if (unpurchasedItems.length > 0) {
            unpurchasedItems.sort((a, b) => (a.currentPrice || 0) - (b.currentPrice || 0));
            const targetItem = unpurchasedItems[0];
            console.log(`[Monitor] ⚡ ĐẶT HÀNG TỨC THÌ CHO SẢN PHẨM: "${targetItem.productName}" (Giá: ${targetItem.currentPrice?.toLocaleString('vi-VN')} đ)`);
            await this.performAutoOrder(targetItem, threshold, config, 1);
          }
        }
      }

      // Chu kỳ quét hoàn tất -> Không reload ở cuối chu kỳ mà sẽ reload ở ĐẦU chu kỳ kế tiếp để chống treo/stale DOM
      if (!this.isRunning || this.isStopping) return;

      this.scheduleNextCycle(config.checkIntervalSeconds || 10);

    } catch (err) {
      console.error(`[Monitor] Lỗi trong chu kỳ #${this.cycleCount}:`, err.message);
      this.currentState = 'ERROR';
      this.emitState({ message: `Lỗi chu kỳ quét: ${err.message}` });

      addLogEntry({
        cycleId: this.cycleCount,
        productName: 'Lỗi chu kỳ quét',
        threshold: threshold,
        status: 'ERROR',
        errorMessage: err.message
      });

      this.retryCount++;
      const retryDelay = Math.min((config.checkIntervalSeconds || 10) * Math.pow(1.5, this.retryCount), 60);
      this.scheduleNextCycle(Math.round(retryDelay));
    }
  }

  async verifyCartPage() {
    if (!this.page || this.page.isClosed()) {
      return { ready: false, message: 'Trang trình duyệt đã bị đóng.' };
    }

    const currentUrl = this.page.url();
    // 0. Kiểm tra nếu gặp Slide CAPTCHA (punish) -> giải ngay lập tức!
    if (currentUrl.includes('punish') || currentUrl.includes('_____tmd_____')) {
      await this.handleCaptchaIfPresent();
      if (!this.page.url().includes('punish')) {
        return { ready: true };
      }
      return { ready: false, isLoginNeeded: false, message: 'Lazada yêu cầu kéo thanh trượt chống bot.' };
    }

    // 1. Kiểm tra nếu bị chuyển hướng sang trang đăng nhập
    if (currentUrl.includes('member/login') || currentUrl.includes('login.lazada.vn')) {
      return {
        ready: false,
        isLoginNeeded: true,
        message: 'Chưa đăng nhập! Vui lòng đăng nhập tài khoản Lazada trên cửa sổ trình duyệt Chromium.'
      };
    }

    // 2. Kiểm tra nếu có popup chống bot (Baxia Dialog / Slide verify) trên trang giỏ hàng
    const hasCaptchaPopup = await this.page.evaluate(() => {
      const baxia = document.querySelector('#baxia-dialog-content, .baxia-dialog, div[class*="baxia"], div[id*="nocaptcha"]');
      const text = document.body ? document.body.innerText : '';
      return !!baxia || text.includes('Please drag the slider to verify') || text.includes('Please slide to verify');
    }).catch(() => false);

    if (hasCaptchaPopup) {
      console.log('[Monitor] ⚠️ Phát hiện popup chống bot trên giỏ hàng, tiến hành tự động kéo thanh trượt...');
      await this.handleCaptchaIfPresent();
    }

    // 3. Kiểm tra xem người dùng có thực sự đăng nhập chưa bằng hàm kiểm tra chuẩn xác
    const loggedIn = await this.checkIsLoggedIn();
    if (!loggedIn) {
      return {
        ready: false,
        isLoginNeeded: true,
        message: 'Trình duyệt của công cụ chưa đăng nhập tài khoản Lazada của bạn! Vui lòng quét mã QR để tiếp tục.'
      };
    }

    // 4. Nếu đã đăng nhập, kiểm tra nhanh xem trên trang đã có sản phẩm giỏ hàng hoặc nút Chọn tất cả
    const cartReady = await this.page.evaluate(() => {
      const items = document.querySelectorAll('.cart-item, [class*="cart-item"], .cart-item-list, .cart-item-title, [id^="item_"]');
      const text = document.body ? document.body.innerText : '';
      const hasSelectAll = text.includes('CHỌN TẤT CẢ') || text.includes('Chọn tất cả');
      const hasEmpty = !!document.querySelector('.cart-empty') || text.includes('Bạn chưa thêm sản phẩm nào vào giỏ');
      return items.length > 0 || hasSelectAll || hasEmpty;
    }).catch(() => false);

    if (cartReady) {
      return { ready: true };
    }

    // 5. Nếu chưa thấy ngay (do React/Vue đang render), chờ tối đa 3s cho container xuất hiện
    try {
      await this.page.waitForSelector('.cart-item, [id^="item_"], .list-header, .cart-empty, .cart-header', { timeout: 3000 });
      return { ready: true };
    } catch (e) {
      return { ready: true };
    }
  }

  async getExpectedItemsCount() {
    try {
      if (!this.page || this.page.isClosed()) return null;
      return await this.page.evaluate(() => {
        // 1. Quét text trên toàn bộ trang hoặc tiêu đề giỏ hàng với Unicode NFC chuẩn
        const bodyText = (document.body ? document.body.innerText : '').normalize('NFC');
        
        // Match dạng: "CHỌN TẤT CẢ (227 SẢN PHẨM)" hoặc "Tất cả (227 sản phẩm)" hoặc "(227 sản phẩm)"
        const patterns = [
          /(?:chọn\s+)?tất\s+cả[^\d\(]{0,25}\(\s*(\d+)\s*(?:sản\s+phẩm|mặt\s+hàng|item|sp)?\s*\)/i,
          /\(\s*(\d+)\s*(?:sản\s+phẩm|mặt\s+hàng|item|sp)\s*\)/i,
          /\b(\d+)\s*sản\s+phẩm\b/i,
          /(?:select\s+all)[^\d\(]{0,25}\(\s*(\d+)/i
        ];

        // Ưu tiên quét trong các container tiêu đề/header trước
        const headers = document.querySelectorAll(
          '.cart-header, .list-header, .checkbox-wrap, label, [class*="header"], [class*="selectAll"], [class*="select-all"]'
        );
        for (const h of headers) {
          const txt = (h.innerText || h.textContent || '').normalize('NFC').trim();
          for (const regex of patterns) {
            const m = txt.match(regex);
            if (m) {
              const num = parseInt(m[1], 10);
              if (!isNaN(num) && num > 0) return num;
            }
          }
        }

        // Dự phòng quét trên toàn bộ body
        for (const regex of patterns) {
          const m = bodyText.match(regex);
          if (m) {
            const num = parseInt(m[1], 10);
            if (!isNaN(num) && num > 0) return num;
          }
        }

        return null;
      });
    } catch (e) {
      return null;
    }
  }

  async scrollToLoadAllItems(expectedCount = null) {
    try {
      if (!this.page || this.page.isClosed()) return;

      if (expectedCount === 0) return;

      const scrollResult = await this.page.evaluate(async (expected) => {
        const getCount = () => document.querySelectorAll('.cart-item, [id^="item_"]').length;
        const initialCount = getCount();

        // Nếu đã đủ số lượng dự kiến ngay từ đầu thì không cần cuộn
        if (expected && initialCount >= expected) {
          return { initial: initialCount, final: initialCount, steps: 0, reason: 'Already reached expected' };
        }

        let lastCount = initialCount;
        let lastHeight = document.body.scrollHeight;
        let noChangeCount = 0;
        let targetExpected = expected;
        const maxSteps = 50; // Tối đa 50 bước cuộn

        let step = 0;
        for (step = 0; step < maxSteps; step++) {
          // Cuộn từng bước 1000px để kích hoạt IntersectionObserver của từng shop
          window.scrollBy(0, 1000);
          await new Promise(r => setTimeout(r, 180));

          const curCount = getCount();
          const curHeight = document.body.scrollHeight;

          // Cập nhật số lượng dự kiến nếu ban đầu chưa phát hiện được
          if (!targetExpected) {
            const bodyTxt = (document.body ? document.body.innerText : '').normalize('NFC');
            const m = bodyTxt.match(/(?:chọn\s+)?tất\s+cả[^\d\(]{0,25}\(\s*(\d+)/i) ||
                      bodyTxt.match(/\(\s*(\d+)\s*(?:sản\s+phẩm|sp)/i) ||
                      bodyTxt.match(/\b(\d+)\s*sản\s+phẩm\b/i);
            if (m) {
              targetExpected = parseInt(m[1], 10);
            }
          }

          // 1. Nếu đã đạt hoặc vượt số lượng sản phẩm dự kiến -> DỪNG NGAY LẬP TỨC!
          if (targetExpected && curCount >= targetExpected) {
            break;
          }

          // 2. Theo dõi thay đổi số lượng và chiều cao
          if (curCount !== lastCount || curHeight !== lastHeight) {
            lastCount = curCount;
            lastHeight = curHeight;
            noChangeCount = 0;
          } else {
            noChangeCount++;

            // Nhấp nhẹ thanh cuộn lên/xuống để kích hoạt sự kiện scroll nếu bị kẹt
            if (noChangeCount % 2 === 0) {
              window.scrollBy(0, -60);
              await new Promise(r => setTimeout(r, 60));
              window.scrollBy(0, 160);
              await new Promise(r => setTimeout(r, 150));
            }

            // Nếu biết targetExpected (ví dụ 227) nhưng chưa đủ:
            // Tuyệt đối KHÔNG dừng sớm vì Lazada đang nạp tiếp. Chỉ dừng khi noChangeCount >= 8 (hơn 1.8s)
            if (targetExpected) {
              if (noChangeCount >= 8) {
                break;
              }
            } else {
              // Khi không biết targetExpected: dừng khi noChangeCount >= 6
              if (noChangeCount >= 6) {
                break;
              }
            }
          }
        }

        // Trở về đầu trang để DOM ổn định cho các thao tác trích xuất và chọn mua
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 80));

        return { initial: initialCount, final: getCount(), steps: step + 1, targetExpected };
      }, expectedCount);

      if (scrollResult && scrollResult.steps > 0) {
        console.log(`[Monitor] Hoàn tất cuộn tải giỏ hàng: Từ ${scrollResult.initial} -> ${scrollResult.final} sản phẩm (${scrollResult.steps} bước).`);
      }
    } catch (e) {
      console.warn('[Monitor] Cảnh báo khi cuộn trang:', e.message);
    }
  }

  async extractCartItems() {
    // 0. Đảm bảo các node giỏ hàng cơ bản đã render sau reload
    await this.page.waitForSelector('.cart-item, [id^="item_"]', { timeout: 8000 }).catch(() => {});
    await this.page.waitForTimeout(400);

    // 1. Đọc số lượng sản phẩm dự kiến từ thẻ: Chọn tất cả (X sản phẩm)
    const expectedCount = await this.getExpectedItemsCount();
    console.log(`[Monitor] 📦 Số lượng sản phẩm dự kiến trong giỏ: ${expectedCount ?? 'Tự động phát hiện'}`);

    // 2. Cuộn tải trang nhanh
    await this.scrollToLoadAllItems(expectedCount);

    // 3. Trích xuất dữ liệu DOM trên context trình duyệt một cách an toàn và chính xác
    return await this.page.evaluate(() => {
      const items = [];

      // Quét theo đúng cấu trúc tiêu chuẩn Lazada: .cart-item (hoặc [id^="item_"])
      const rawNodes = Array.from(document.querySelectorAll(
        '.cart-item, [id^="item_"]'
      ));

      // Lọc bỏ:
      // - Phần tử con nằm lồng trong phần tử item khác
      // - Phần tử nằm trong khối gợi ý (recommendations, just-for-you, similar)
      // - Sản phẩm hết hàng, bị vô hiệu hóa hoặc đã xóa
      // - Sản phẩm KHÔNG CÓ checkbox hợp lệ (nếu không có checkbox thì không thể mua)
      const itemNodes = rawNodes.filter(node => {
        if (!node) return false;
        if (node.classList.contains('checkout-shop') || node.classList.contains('list-header') || node.classList.contains('cart-item-list')) return false;

        // Bỏ qua nếu là con của một node item khác
        if (rawNodes.some(other => other !== node && other.contains(node))) return false;

        // Bỏ qua nếu nằm trong các khối gợi ý của Lazada (recommendations / just for you / similar)
        if (node.closest('.recommend-list, .cart-recommend, [class*="recommend"], [class*="just-for-you"], [class*="similar"], [data-spm*="recommend"]')) {
          return false;
        }

        // Bỏ qua nếu sản phẩm bị vô hiệu hóa / hết hàng / xóa
        if (node.classList.contains('cart-item-disabled') || node.classList.contains('item-del')) {
          return false;
        }
        if (node.closest('.cart-item-list-disabled, .disabled-items, [class*="unavailable"], [class*="disabled-item"]')) {
          return false;
        }

        const textContent = (node.innerText || node.textContent || '').toLowerCase();
        if (textContent.includes('sản phẩm này tạm thời hết hàng') ||
            textContent.includes('hết hàng') ||
            textContent.includes('hàng không có sẵn') ||
            textContent.includes('đã xóa') ||
            textContent.includes('ngừng kinh doanh')) {
          return false;
        }

        // Kiểm tra checkbox: sản phẩm hợp lệ trong giỏ hàng bắt buộc phải có checkbox hoạt động
        const cbInput = node.querySelector('input[type="checkbox"]');
        const cbLabel = node.querySelector('.cart-item-checkbox, .next-checkbox');
        if (!cbInput && !cbLabel) {
          return false;
        }
        if (cbInput && (cbInput.disabled || cbInput.getAttribute('aria-disabled') === 'true')) {
          return false;
        }
        if (cbLabel && cbLabel.classList.contains('disabled')) {
          return false;
        }

        return true;
      });

      if (itemNodes.length > 0) {
        itemNodes.forEach((node) => {
          // Lấy Tên sản phẩm & Link: Quét các link và ưu tiên thẻ có nội dung text hợp lệ
          let productName = '';
          let productUrl = '';
          const titleCandidates = Array.from(node.querySelectorAll(
            '.automation-link-from-title-to-prod, a.title, .item-title, a[href*="products"], [class*="title"] a, a'
          ));
          for (const a of titleCandidates) {
            const txt = (a.getAttribute('title') || a.textContent || '').trim();
            if (txt.length > 5 && !txt.includes('Shop') && !txt.includes('Gian hàng') && !txt.includes('Lazada')) {
              productName = txt;
              productUrl = a.href || '';
              break;
            }
          }
          if (!productName && titleCandidates.length > 0) {
            for (const a of titleCandidates) {
              const txt = (a.textContent || '').trim();
              if (txt.length > 3) {
                productName = txt;
                productUrl = a.href || '';
                break;
              }
            }
          }

          // Lấy Tên Shop nếu có (nằm ở checkout-shop trước đó hoặc cha)
          let shopName = '';
          const shopContainer = node.closest('.checkout-shop-children-item, .shop-group, .checkout-shop-item') || node.parentElement;
          if (shopContainer) {
            const shopTitleEl = shopContainer.querySelector('.checkout-shop-name, .shop-name');
            if (shopTitleEl) shopName = shopTitleEl.textContent.trim();
          }

          // Lấy Phân loại (SKU) nếu có
          const skuEl = node.querySelector('.sku, .automation-link-from-sub-title-to-prod');
          const skuText = skuEl ? ` (${skuEl.textContent.trim()})` : '';

          // Lấy Giá hiện tại:
          // Ưu tiên cao nhất: Trích xuất từ .cart-item-right hoặc .current-price, tuyệt đối không lấy nhầm nhãn voucher / mã giảm giá ở .cart-item-middle
          let rawPriceText = '';
          const rightEl = node.querySelector('.cart-item-right, .cart-item-price');

          if (rightEl) {
            // 1. Tìm trực tiếp thẻ .current-price trong khối bên phải
            const currentPriceEl = rightEl.querySelector('.current-price, [class*="current-price"]');
            if (currentPriceEl) {
              rawPriceText = (currentPriceEl.innerText || currentPriceEl.textContent || '').trim();
            } else {
              // 2. Nếu không có .current-price riêng, lấy từ rightEl và loại bỏ origin-price, gạch ngang, quantity
              const cloneRight = rightEl.cloneNode(true);
              const toRemove = cloneRight.querySelectorAll('.origin-price, [class*="origin"], del, s, strike, .next-number-picker, .operations, [class*="voucher"], [class*="coupon"], [class*="promo"]');
              toRemove.forEach(el => el.remove());
              const match = (cloneRight.innerText || cloneRight.textContent || '').match(/[\d.,]{3,}/);
              if (match) rawPriceText = match[0];
            }
          }

          // Fallback 1: Tìm .current-price trong toàn bộ node
          if (!rawPriceText) {
            const currentPriceEl = node.querySelector('.current-price, [class*="current-price"]');
            if (currentPriceEl) {
              rawPriceText = (currentPriceEl.innerText || currentPriceEl.textContent || '').trim();
            }
          }

          // Fallback 2: Kiểm tra nếu có nhãn "Giá đã giảm" / "đã giảm"
          if (!rawPriceText) {
            const textAll = node.innerText || node.textContent || '';
            const discountMatch = textAll.match(/([\d.,]{3,})\s*(?:₫\s*)?(?:\n|\r|\s)*(?:Giá\s+)?đã\s*giảm/i)
                               || textAll.match(/(?:Giá\s+)?đã\s*giảm\s*(?:₫\s*)?(?:\n|\r|\s)*([\d.,]{3,})/i);
            if (discountMatch && discountMatch[1]) {
              rawPriceText = discountMatch[1].trim();
            }
          }

          // Fallback 3: Tìm phần tử có màu cam/đỏ đặc trưng của giá Lazada
          if (!rawPriceText) {
            const allElements = Array.from(node.querySelectorAll('*'));
            for (const el of allElements) {
              const cls = el.className || '';
              if (typeof cls === 'string' && (cls.includes('voucher') || cls.includes('coupon') || cls.includes('promo') || cls.includes('origin'))) {
                continue;
              }
              const color = el.style?.color || '';
              if (color.includes('245, 114, 36') || color.includes('#f57224') || color.includes('rgb(255, 96, 0)')) {
                const text = (el.innerText || el.textContent || '').trim();
                const m = text.match(/[\d.,]{3,}/);
                if (m) {
                  rawPriceText = m[0];
                  break;
                }
              }
            }
          }

          // Lấy Số lượng từ input
          const qtyEl = node.querySelector(
            '.next-number-picker-input input, .quantity input, input.number, input[type="text"]'
          );
          const quantity = qtyEl ? (parseInt(qtyEl.value, 10) || 1) : 1;

          if (productName || rawPriceText) {
            const fullName = (shopName ? `[${shopName}] ` : '') + (productName || 'Sản phẩm Lazada') + skuText;
            items.push({
              itemId: node.id || '',
              productKey: (node.id || productUrl || productName || Math.random().toString()),
              productName: fullName,
              productUrl: productUrl,
              rawPriceText: rawPriceText,
              quantity: quantity
            });
          }
        });
      }

      // TUYỆT ĐỐI KHÔNG DÙNG FALLBACK QUÉT LIÊN KẾT TOÀN TRANG:
      // Fallback quét liên kết toàn trang trước đây quét nhầm sản phẩm "Gợi ý / Có thể bạn thích" khi giỏ hàng trống!
      return items;
    })
    .then(rawItems => {
      // Chuyển đổi text giá sang số nguyên VND tại Node.js environment
      return rawItems.map(item => {
        const parsedPrice = parseVNDPrice(item.rawPriceText);
        return {
          ...item,
          currentPrice: parsedPrice
        };
      });
    });
  }

  async reloadCartPage() {
    try {
      if (this.page && !this.page.isClosed()) {
        const config = loadConfig();
        const targetCartUrl = (config.cartUrl && config.cartUrl.trim()) ? config.cartUrl.trim() : LAZADA_CART_URL;
        await this.page.goto(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        // Chờ thêm 3 giây để dữ liệu giỏ hàng hydrate đầy đủ
        await this.page.waitForTimeout(3000);
      }
    } catch (e) {
      console.warn('[Monitor] Cảnh báo khi reload trang giỏ hàng:', e.message);
    }
  }

  scheduleNextCycle(seconds) {
    if (!this.isRunning || this.isStopping) return;

    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
    }

    console.log(`[Monitor] Chờ ${seconds} giây trước khi bắt đầu chu kỳ kế tiếp...`);
    this.emitState({
      nextCycleIn: seconds,
      message: `Đang chờ ${seconds} giây trước khi quét chu kỳ #${this.cycleCount + 1}...`
    });

    this.cycleTimer = setTimeout(() => {
      this.runCycle();
    }, seconds * 1000);
  }

  async sendTelegramAlerts(config, items, threshold) {
    if (!config.telegram?.enabled || !config.telegram.botToken || !config.telegram.chatId) {
      console.log('[Monitor] Telegram bị tắt hoặc chưa cấu hình Bot Token / Chat ID.');
      return;
    }

    try {
      console.log(`[Monitor] 📲 Đang gửi thông báo Telegram cho ${items.length} sản phẩm giảm giá...`);
      let res;
      if (config.telegram.batchNotifications && items.length > 1) {
        // Gửi thông báo gộp
        const msg = formatBatchAlertMessage(items, threshold);
        res = await sendTelegramMessage(config.telegram.botToken, config.telegram.chatId, msg);
      } else {
        // Gửi từng sản phẩm riêng lẻ
        for (const item of items) {
          const msg = formatProductAlertMessage(item, threshold);
          res = await sendTelegramMessage(config.telegram.botToken, config.telegram.chatId, msg);
        }
      }

      const isSuccess = res && res.success;
      console.log(`[Monitor] Kết quả gửi Telegram: ${isSuccess ? '✅ Thành công' : '❌ Thất bại: ' + (res?.error || 'Không rõ')}`);

      const newStatus = isSuccess ? 'SENT' : `FAIL: ${res?.error || 'Lỗi'}`;
      for (const item of items) {
        if (item.logId) {
          updateLogTelegramStatus(item.logId, newStatus);
        }
      }
    } catch (err) {
      console.error('[Monitor] Lỗi gửi thông báo Telegram:', err.message);
      for (const item of items) {
        if (item.logId) {
          updateLogTelegramStatus(item.logId, `Lỗi: ${err.message}`);
        }
      }
    }
  }

  /**
   * Tự động chuyển trang sang Đăng nhập Lazada, bấm tab QR và chụp ảnh mã QR
   * Tách biệt hoàn toàn: Chế độ này KHÔNG tự động quét hay chạy chu kỳ giám sát!
   */
  async openLoginPageAndPrepareQr() {
    try {
      this.isRunning = false;
      this.isLoginMode = true;
      this.currentState = 'WAITING_LOGIN';
      this.emitState({
        type: 'LOGIN_REQUIRED',
        state: 'WAITING_LOGIN',
        message: 'Đang kết nối và mở trang đăng nhập Lazada (quét QR)...'
      });

      await this.ensureBrowser();
      if (!this.page || this.page.isClosed()) return null;

      // Xóa chu kỳ hẹn giờ cũ nếu đang đợi
      if (this.cycleTimer) {
        clearTimeout(this.cycleTimer);
        this.cycleTimer = null;
      }

      const currentUrl = this.page.url();
      const isAlreadyOnLoginPage = currentUrl.includes('member/login') || currentUrl.includes('login.lazada.vn');

      if (!isAlreadyOnLoginPage) {
        console.log('[Monitor] Tự động điều hướng đến trang đăng nhập Lazada: https://member.lazada.vn/user/login?redirect=https%3A%2F%2Fcart.lazada.vn%2Fcart');
        await this.safeNavigate('https://member.lazada.vn/user/login?redirect=https%3A%2F%2Fcart.lazada.vn%2Fcart', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await this.page.waitForTimeout(2000);
      }

      // Xử lý CAPTCHA nếu xuất hiện ngay trên trang đăng nhập
      await this.handleCaptchaIfPresent();

      // Thử click vào biểu tượng mã QR (Login with QR) cạnh tab Password nếu đang ở tab nhập mật khẩu
      let qrClicked = false;
      try {
        const qrTarget = await this.page.evaluate(() => {
          const allElements = Array.from(document.querySelectorAll('*'));
          
          // 1. Tìm element có title hoặc aria chính xác là 'Login with QR'
          for (const el of allElements) {
            const title = (el.getAttribute('title') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (title.includes('login with qr') || aria.includes('login with qr')) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, method: 'title' };
              }
            }
          }

          // 2. Tìm theo tab Password trong form đăng nhập
          for (const el of allElements) {
            const t = (el.innerText || '').trim();
            if (t === 'Password') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && rect.top > 100) {
                return { x: rect.left - 24, y: rect.top + rect.height / 2, method: 'password-left' };
              }
            }
          }
          return null;
        });

        if (qrTarget) {
          console.log('[Monitor] Tìm thấy nút QR tại tọa độ:', qrTarget);
          await this.page.mouse.click(qrTarget.x, qrTarget.y);
          qrClicked = true;
          await this.page.waitForTimeout(1500);
        }
      } catch (e) {
        console.warn('[Monitor] Cảnh báo khi thử click mã QR:', e.message);
      }

      // Chụp ảnh màn hình lưu vào thư mục public để Web Dashboard hiển thị
      const qrPath = path.join(__dirname, '..', 'public', 'login-qr.png');
      await this.page.screenshot({ path: qrPath });

      try {
        await this.page.bringToFront();
      } catch (e) {}

      const qrImgUrl = '/login-qr.png?t=' + Date.now();

      this.emitState({
        type: 'LOGIN_REQUIRED',
        state: 'WAITING_LOGIN',
        qrImage: qrImgUrl,
        message: '📱 Đã mở trang đăng nhập Lazada! Vui lòng dùng ứng dụng Lazada quét mã QR để tiếp tục.'
      });

      // Tuyệt đối KHÔNG tự động hẹn giờ quét scan cycle khi người dùng đang ở chế độ đăng nhập!

      return {
        success: true,
        qrClicked,
        qrImage: qrImgUrl
      };
    } catch (err) {
      console.error('[Monitor] Lỗi openLoginPageAndPrepareQr:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Phát hiện và tự động xử lý thanh trượt xác minh (Slide CAPTCHA / Baxia Dialog) của Lazada/Alibaba nếu xuất hiện
   */
  async handleCaptchaIfPresent() {
    try {
      if (!this.page || this.page.isClosed()) return false;

      const trackSelectors = [
        '#nc_1_wrapper',
        'div.nc_scale',
        'div[class*="nc_scale"]',
        '.nc_scale',
        '#baxia-dialog-content div.nc_scale',
        '.baxia-dialog div.nc_scale',
        'div[id*="nc_"][class*="scale"]',
        'div[class*="scale_text"]',
        '.slidetounlock',
        '.nc-container div[class*="scale"]'
      ];

      const btnSelectors = [
        'span.btn_slide',
        'span[class*="btn_slide"]',
        'span[id*="_n1z"]',
        '#nc_1_n1z',
        '.nc_iconfont.btn_slide',
        '[class*="btn_slide"]',
        'div[class*="btn_slide"]'
      ];

      for (const target of [this.page, ...this.page.frames()]) {
        try {
          let trackLocator = null;
          for (const sel of trackSelectors) {
            const loc = target.locator(sel).first();
            if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
              trackLocator = loc;
              break;
            }
          }

          if (trackLocator) {
            const box = await trackLocator.boundingBox();
            if (box && box.width > 80) {
              console.log('[Monitor] ⚠️ Phát hiện thanh trượt xác minh chống bot (Slide CAPTCHA) Lazada! Track box:', box);
              this.emitState({
                message: '⚠️ Lazada yêu cầu kéo thanh trượt chống bot... Đang tự động kéo thanh trượt...'
              });

              // Chờ ngắn để JS/WASM của slider nạp đầy đủ
              await this.page.waitForTimeout(600);

              // Tìm vị trí chính xác của nút kéo
              let btnLocator = null;
              for (const bSel of btnSelectors) {
                const bLoc = target.locator(bSel).first();
                if (await bLoc.isVisible({ timeout: 200 }).catch(() => false)) {
                  btnLocator = bLoc;
                  break;
                }
              }

              let startX = box.x + 22;
              let startY = box.y + box.height / 2;

              if (btnLocator) {
                const btnBox = await btnLocator.boundingBox();
                if (btnBox) {
                  startX = btnBox.x + btnBox.width / 2;
                  startY = btnBox.y + btnBox.height / 2;
                }
              }

              const endX = box.x + box.width - 8;
              const distance = endX - startX;

              console.log(`[Monitor] 🔄 Bắt đầu kéo thanh trượt từ (${Math.round(startX)}, ${Math.round(startY)}) sang (${Math.round(endX)}, ${Math.round(startY)})...`);
              await this.page.mouse.move(startX, startY);
              await this.page.waitForTimeout(100);
              await this.page.mouse.down();
              await this.page.waitForTimeout(50);

              const steps = 30;
              for (let i = 1; i <= steps; i++) {
                const currentX = startX + (distance * i / steps);
                const currentY = startY + Math.sin(i / 2) * 2;
                await this.page.mouse.move(currentX, currentY);
                await this.page.waitForTimeout(10 + Math.random() * 8);
              }
              await this.page.waitForTimeout(100);
              await this.page.mouse.up();
              console.log('[Monitor] ✅ Đã thả thanh trượt. Chờ Lazada xác thực token...');
              await this.page.waitForTimeout(3000);

              try {
                const qrPath = path.join(__dirname, '..', 'public', 'login-qr.png');
                await this.page.screenshot({ path: qrPath });
              } catch (e) {}

              return true;
            }
          }
        } catch (e) {}
      }
      return false;
    } catch (e) {
      console.warn('[Monitor] Cảnh báo khi xử lý CAPTCHA:', e.message);
      return false;
    }
  }

  /**
   * Tự động đặt hàng với tốc độ cao, xử lý ngay lập tức khi phát hiện giá giảm và thử lại tức thì nếu gặp lỗi
   */
  async performAutoOrder(targetItem, threshold, config, attempt = 1) {
    const MAX_ORDER_ATTEMPTS = 5;

    if (this.isOrdering && attempt === 1) {
      console.log('[AutoOrder] Đang có một tiến trình đặt hàng đang chạy, bỏ qua.');
      return;
    }

    if (!this.isRunning || this.isStopping) return;

    this.isOrdering = true;
    console.log(`[AutoOrder] ==========================================`);
    console.log(`[AutoOrder] ⚡ [TỐC ĐỘ CAO] BẮT ĐẦU ĐẶT HÀNG CHO SẢN PHẨM: ${targetItem.productName} (Lần thử ${attempt}/${MAX_ORDER_ATTEMPTS})`);
    console.log(`[AutoOrder] Giá: ${targetItem.currentPrice?.toLocaleString('vi-VN')} đ | Ngưỡng: ${threshold?.toLocaleString('vi-VN')} đ`);
    console.log(`[AutoOrder] ==========================================`);

    this.emitState({
      message: `⚡ [Lần thử ${attempt}/${MAX_ORDER_ATTEMPTS}] Đang tự động đặt hàng tức thì: ${targetItem.productName}...`
    });

    let onResponseHandler = null;
    const targetCartUrl = (config.cartUrl && config.cartUrl.trim()) ? config.cartUrl.trim() : LAZADA_CART_URL;

    try {
      if (!this.page || this.page.isClosed()) {
        throw new Error('Trình duyệt chưa sẵn sàng hoặc trang đã bị đóng');
      }

      // Đảm bảo đang ở trang giỏ hàng (không chờ đợi thừa)
      const curUrl = this.page.url();
      if (!curUrl.includes('/cart')) {
        await this.page.goto(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
      }

      // Lắng nghe response API để phát hiện lỗi từ server Lazada
      onResponseHandler = async (res) => {
        try {
          const u = res.url();
          if (u.includes('lazada.vn') && (u.includes('api') || u.includes('checkout') || u.includes('shipping') || u.includes('trade') || u.includes('cart'))) {
            const status = res.status();
            let bodyText = '';
            try { bodyText = (await res.text()).slice(0, 300); } catch (e) {}
            if (status >= 400 || bodyText.includes('false') || bodyText.includes('error') || bodyText.includes('LZD') || bodyText.includes('fail') || bodyText.includes('Lỗi')) {
              console.log(`[Lazada API Error] Status ${status} | URL: ${u.split('?')[0]} | Body: ${bodyText}`);
            }
          }
        } catch (e) {}
      };
      this.page.on('response', onResponseHandler);

      // BƯỚC 1: Xử lý checkbox nhanh và chính xác
      const isRetry = attempt > 1;
      const checkboxStatus = await this.page.evaluate((target, retry) => {
        const rawNodes = Array.from(document.querySelectorAll('.cart-item, [id^="item_"]')).filter(n => {
          if (n.closest('.recommend-list, .cart-recommend, [class*="recommend"], [class*="just-for-you"], [class*="similar"]')) return false;
          if (n.classList.contains('cart-item-disabled') || n.classList.contains('item-del')) return false;
          return true;
        });

        let targetNode = null;
        if (target.itemId) {
          targetNode = document.getElementById(target.itemId);
        }
        if (!targetNode && target.productUrl) {
          const cleanUrl = target.productUrl.split('?')[0].replace('https://www.lazada.vn', '').replace('http://www.lazada.vn', '');
          if (cleanUrl.length > 5) {
            const link = document.querySelector(`.cart-item a[href*="${cleanUrl}"], [id^="item_"] a[href*="${cleanUrl}"]`);
            if (link) targetNode = link.closest('.cart-item, [id^="item_"]');
          }
        }
        if (!targetNode && target.productName) {
          const shortName = target.productName.slice(0, 30).toLowerCase();
          targetNode = rawNodes.find(n => (n.innerText || '').toLowerCase().includes(shortName));
        }

        let targetChecked = false;
        if (targetNode) {
          const input = targetNode.querySelector('input[type="checkbox"]');
          const label = targetNode.querySelector('label.cart-item-checkbox, .next-checkbox');
          targetChecked = (input && (input.checked || input.getAttribute('aria-checked') === 'true')) ||
                          (label && label.classList.contains('checked'));
        }

        const allCheckedInputs = rawNodes.flatMap(n => Array.from(n.querySelectorAll('input[type="checkbox"]'))).filter(cb => cb.checked);
        const selectAllEl = document.querySelector('.list-header-checkbox input[type="checkbox"], .list-header .next-checkbox input[type="checkbox"]');
        const isSelectAll = selectAllEl ? (selectAllEl.checked || selectAllEl.getAttribute('aria-checked') === 'true') : false;

        return {
          foundTarget: !!targetNode,
          targetChecked: !!targetChecked,
          totalChecked: allCheckedInputs.length,
          isSelectAll: isSelectAll,
          isRetry: retry
        };
      }, { itemId: targetItem.itemId, productUrl: targetItem.productUrl, productName: targetItem.productName }, isRetry);

      if (!checkboxStatus.foundTarget) {
        throw new Error(`Không tìm thấy sản phẩm "${targetItem.productName}" trong giỏ hàng.`);
      }

      // Xác định container của sản phẩm mục tiêu
      let itemContainer = null;
      if (targetItem.itemId) {
        const byId = this.page.locator(`#${targetItem.itemId}`);
        if (await byId.count() > 0) itemContainer = byId.first();
      }
      if (!itemContainer && targetItem.productUrl) {
        const cleanUrl = targetItem.productUrl.split('?')[0];
        const byUrl = this.page.locator(`.cart-item:has(a[href*="${cleanUrl}"]), [id^="item_"]:has(a[href*="${cleanUrl}"])`);
        if (await byUrl.count() > 0) itemContainer = byUrl.first();
      }
      if (!itemContainer && targetItem.productName) {
        const shortName = targetItem.productName.slice(0, 30);
        const byText = this.page.locator(`.cart-item, [id^="item_"]`).filter({ hasText: shortName });
        if (await byText.count() > 0) itemContainer = byText.first();
      }

      if (!itemContainer) {
        throw new Error(`Không thể xác định selector của sản phẩm "${targetItem.productName}".`);
      }

      const itemCb = itemContainer.locator('.cart-item-checkbox, label.next-checkbox, input[type="checkbox"]').first();
      if (await itemCb.count() === 0) {
        throw new Error(`Không tìm thấy ô checkbox của sản phẩm "${targetItem.productName}".`);
      }

      // Tối ưu tốc độ checkbox:
      // Trong trường hợp retry (thử lại sau lỗi hệ thống Lazada), uncheck và re-check lại để làm mới token thanh toán
      if (isRetry && checkboxStatus.targetChecked) {
        console.log('[AutoOrder] 🔄 Thử lại: Hủy chọn và chọn lại sản phẩm để làm mới phiên token giỏ hàng...');
        await itemCb.click();
        await this.page.waitForTimeout(50);
        await itemCb.click();
        await this.page.waitForTimeout(50);
      } else if (checkboxStatus.targetChecked && (checkboxStatus.totalChecked === 1 || (!checkboxStatus.isSelectAll && checkboxStatus.totalChecked <= 1))) {
        console.log('[AutoOrder] ⚡ Sản phẩm mục tiêu đã được tích chọn sẵn và duy nhất, bỏ qua thao tác checkbox!');
      } else {
        // Nếu "CHỌN TẤT CẢ" đang tích hoặc có nhiều sản phẩm khác được chọn: Bỏ chọn tất cả nhanh
        if (checkboxStatus.isSelectAll || checkboxStatus.totalChecked > 1) {
          console.log('[AutoOrder] Bỏ chọn tất cả để chỉ chọn duy nhất sản phẩm mục tiêu...');
          const selectAllLocator = this.page.locator('.list-header-checkbox, label.list-header-checkbox').first();
          if (await selectAllLocator.count() > 0) {
            await selectAllLocator.click();
            await this.page.waitForTimeout(60);
          }
        }

        // Tích chọn sản phẩm mục tiêu
        console.log('[AutoOrder] ⚡ Click vào ô checkbox của sản phẩm...');
        await itemCb.click();
        await this.page.waitForTimeout(60);
      }

      // BƯỚC 2: Click vào nút THANH TOÁN
      const checkoutBtn = this.page.locator('.checkout-order-total-button, button.automation-checkout-order-total-button-button, button:has-text("THANH TOÁN")').first();
      await checkoutBtn.waitFor({ state: 'visible', timeout: 4000 });

      // Chờ nhanh (poll mỗi 30ms) cho đến khi nút thanh toán cập nhật số lượng >= 1
      let checkoutText = await checkoutBtn.innerText().catch(() => '');
      for (let i = 0; i < 40; i++) {
        if (checkoutText && !checkoutText.includes('(0)')) break;
        await this.page.waitForTimeout(30);
        checkoutText = await checkoutBtn.innerText().catch(() => '');
      }

      if (checkoutText.includes('(0)')) {
        throw new Error('Chưa chọn được sản phẩm: Nút thanh toán vẫn hiển thị THANH TOÁN(0)');
      }

      console.log(`[AutoOrder] ⚡ Tiến hành click nút "${checkoutText}"...`);
      await checkoutBtn.click({ force: true });

      // BƯỚC 3: Chờ chuyển sang trang thanh toán (checkout/shipping) với cơ chế re-click nhanh
      console.log('[AutoOrder] Đang chuyển sang trang thanh toán...');
      let reachedCheckout = false;

      for (let i = 0; i < 45; i++) {
        await this.page.waitForTimeout(40);
        const curCheckoutUrl = this.page.url();
        if (curCheckoutUrl.includes('/checkout') || curCheckoutUrl.includes('shipping') || curCheckoutUrl.includes('punish')) {
          reachedCheckout = true;
          break;
        }

        // Nếu sau 400ms hoặc 800ms vẫn ở /cart, bấm lại nút THANH TOÁN ngay lập tức
        if (i === 10 || i === 20) {
          if (await checkoutBtn.isVisible().catch(() => false)) {
            console.log('[AutoOrder] Vẫn ở trang giỏ hàng, re-click nút THANH TOÁN ngay...');
            await checkoutBtn.click({ force: true }).catch(() => {});
          }
        }
      }

      if (!reachedCheckout) {
        throw new Error(`Kẹt tại giỏ hàng: Không thể chuyển sang trang thanh toán (${this.page.url()}).`);
      }

      // Xử lý CAPTCHA ngay lập tức nếu xuất hiện
      await this.handleCaptchaIfPresent();

      // BƯỚC 4: Tìm và click nút "Đặt hàng" màu cam trên trang thanh toán với tốc độ cao
      const clickOrangeDatHang = async () => {
        return await this.page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            const text = (el.innerText || '').trim();
            const style = window.getComputedStyle(el);
            const bg = style.backgroundColor;
            const isOrange = bg.includes('245, 114, 36') || bg.includes('255, 96, 0') || bg.includes('255, 102, 0');
            if ((text === 'Đặt hàng' || text === 'ĐẶT HÀNG') && (isOrange || el.closest('.checkout-order-total'))) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 50 && rect.height > 20) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
              }
            }
          }
          return { found: false };
        });
      };

      console.log('[AutoOrder] ⚡ Tìm kiếm và click nút "Đặt hàng" màu cam...');
      const orderWaitDeadline = Date.now() + 15000;
      let orderClicked = false;

      while (Date.now() < orderWaitDeadline && !orderClicked) {
        // Kiểm tra ngay màn hình lỗi hệ thống Lazada
        const hasSystemError = await this.page.evaluate(() => {
          const t = document.body ? document.body.innerText : '';
          return t.includes('lỗi hệ thống') || t.includes('LZD_BUY_RENDER') || t.includes('quay lại giỏ hàng');
        }).catch(() => false);

        if (hasSystemError) {
          throw new Error('Lỗi hệ thống Lazada trên trang thanh toán ("quay lại giỏ hàng").');
        }

        const clickRes = await clickOrangeDatHang();
        if (clickRes.found) {
          console.log(`[AutoOrder] ⚡ ĐÃ CLICK NÚT "ĐẶT HÀNG" TẠI (${clickRes.x}, ${clickRes.y})!`);
          orderClicked = true;
          break;
        }

        // Ẩn widget chat nếu che khuất
        await this.page.evaluate(() => {
          const chatMin = document.querySelector('.im-app__cont-minimize, [class*="im-app"], [class*="chat-widget"]');
          if (chatMin) chatMin.style.display = 'none';
        }).catch(() => {});

        await this.page.waitForTimeout(40);
      }

      if (!orderClicked) {
        try {
          const errPath = path.join(__dirname, '..', 'public', 'debug-order-error.png');
          await this.page.screenshot({ path: errPath, fullPage: true });
        } catch (scErr) {}
        throw new Error(`Timeout 15s: Không tìm thấy nút "Đặt hàng" trên trang thanh toán (${this.page.url()}).`);
      }

      // BƯỚC 5: Theo dõi cổng thanh toán MoMo hoặc chuyển hướng thành công ngay lập tức (Zero-delay)
      console.log('[AutoOrder] ⚡ Theo dõi phản hồi đơn hàng (MoMo / Xác nhận tạo đơn)...');
      let momoPage = null;
      let orderConfirmed = false;
      const momoWaitDeadline = Date.now() + 12000;

      while (Date.now() < momoWaitDeadline && !momoPage && !orderConfirmed) {
        // Kiểm tra Slide CAPTCHA nếu xuất hiện sau khi nhấn Đặt hàng
        const hadSlider = await this.handleCaptchaIfPresent();
        if (hadSlider && (this.page.url().includes('shipping') || this.page.url().includes('checkout'))) {
          await clickOrangeDatHang();
        }

        const pages = this.browserContext ? this.browserContext.pages() : [this.page];
        for (const p of pages) {
          try {
            if (p.isClosed()) continue;
            const u = p.url();
            if (u.includes('momo.vn') || u.includes('payment.momo.vn')) {
              momoPage = p;
              break;
            }
            if (u.includes('order/pay/result') || u.includes('checkout/success') || (u.includes('order') && u.includes('success'))) {
              orderConfirmed = true;
              break;
            }
            const hasMomoText = await p.evaluate(() => {
              const body = document.body ? document.body.innerText : '';
              return body.includes('Cổng thanh toán MoMo') || 
                     body.includes('Quét mã QR để liên kết với LAZADA') ||
                     body.includes('Quét mã QR để liên kết') ||
                     body.includes('liên kết với LAZADA') ||
                     body.includes('Hủy phiên liên kết dịch vụ');
            }).catch(() => false);
            if (hasMomoText) {
              momoPage = p;
              break;
            }
          } catch (e) {}
        }

        if (momoPage || orderConfirmed) break;
        await this.page.waitForTimeout(50);
      }

      if (momoPage) {
        console.log(`[AutoOrder] 📱 Phát hiện Cổng thanh toán MoMo tại: ${momoPage.url()}`);
        this.emitState({ message: '📱 Đang xử lý Cổng MoMo (Quay về -> Hủy phiên)...' });

        try {
          const momoPath = path.join(__dirname, '..', 'public', 'debug-momo-qr.png');
          await momoPage.screenshot({ path: momoPath });
        } catch (e) {}

        // Bấm Quay về trên MoMo tức thì
        const backBtnSelectors = [
          'button:has-text("Quay về")',
          'a:has-text("Quay về")',
          '[role="button"]:has-text("Quay về")',
          'span:has-text("Quay về")',
          'div:has-text("Quay về")',
          '.back-btn',
          '.btn-back',
          '[class*="back"]'
        ];

        let backBtnClicked = false;
        for (const sel of backBtnSelectors) {
          try {
            const loc = momoPage.locator(sel).first();
            if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
              await loc.click({ force: true });
              backBtnClicked = true;
              break;
            }
          } catch (e) {}
        }

        if (!backBtnClicked) {
          await momoPage.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('a, button, span, div, p'));
            for (const el of elements) {
              const text = (el.innerText || el.textContent || '').trim();
              if (text === 'Quay về' || text === '< Quay về' || text.includes('Quay về')) {
                el.click();
                return true;
              }
            }
            return false;
          }).catch(() => false);
        }

        // Bấm HỦY PHIÊN trong modal tức thì
        const cancelSessionSelectors = [
          'button:has-text("HỦY PHIÊN")',
          'button:has-text("Hủy phiên")',
          'button:has-text("Hủy Phiên")',
          'a:has-text("HỦY PHIÊN")',
          'a:has-text("Hủy phiên")',
          '[role="button"]:has-text("HỦY PHIÊN")',
          '[role="button"]:has-text("Hủy phiên")',
          'button.btn-primary',
          'button.btn-danger',
          'div:text-is("HỦY PHIÊN")'
        ];

        let cancelBtnClicked = false;
        for (let poll = 0; poll < 15; poll++) {
          for (const sel of cancelSessionSelectors) {
            try {
              const loc = momoPage.locator(sel).first();
              if (await loc.isVisible({ timeout: 100 }).catch(() => false)) {
                await loc.click({ force: true });
                cancelBtnClicked = true;
                break;
              }
            } catch (e) {}
          }
          if (cancelBtnClicked) break;
          await momoPage.waitForTimeout(50);
        }

        if (!cancelBtnClicked) {
          await momoPage.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, a, div, span'));
            for (const el of elements) {
              const text = (el.innerText || el.textContent || '').trim();
              if (text === 'HỦY PHIÊN' || text === 'Hủy phiên' || text.toUpperCase() === 'HỦY PHIÊN') {
                el.click();
                return true;
              }
            }
            return false;
          }).catch(() => false);
        }

        console.log('[AutoOrder] ✅ Đã bấm HỦY PHIÊN trên MoMo.');

        if (momoPage !== this.page && !momoPage.isClosed()) {
          try {
            await momoPage.close();
          } catch (e) {}
        }
      } else {
        console.log('[AutoOrder] Đơn hàng đã được tạo trực tiếp qua Lazada.');
      }

      // BƯỚC 6: KIỂM TRA XÁC THỰC GIỎ HÀNG THỰC TẾ NGAY TỨC THÌ
      console.log('[AutoOrder] 🔍 Kiểm tra xác thực đơn hàng trên giỏ hàng...');
      this.emitState({ message: '🔍 Đang kiểm tra giỏ hàng để xác thực đơn hàng...' });
      await this.page.goto(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

      try {
        const postOrderCartPath = path.join(__dirname, '..', 'public', 'debug-post-order-cart.png');
        await this.page.screenshot({ path: postOrderCartPath });
      } catch (e) {}

      // Hàm kiểm tra xem sản phẩm còn nằm trong giỏ hàng hay không (chỉ xét sản phẩm khả dụng)
      const checkItemStillInCart = async () => {
        return await this.page.evaluate((target) => {
          const rawNodes = Array.from(document.querySelectorAll('.cart-item, [id^="item_"]'));
          const activeNodes = rawNodes.filter(node => {
            if (node.closest('.recommend-list, .cart-recommend, [class*="recommend"], [class*="just-for-you"], [class*="similar"]')) return false;
            if (node.classList.contains('cart-item-disabled') || node.classList.contains('item-del')) return false;
            if (node.closest('.cart-item-list-disabled, .disabled-items, [class*="unavailable"], [class*="disabled-item"]')) return false;
            return true;
          });

          // 1. Kiểm tra theo Item ID nếu có
          if (target.itemId) {
            const el = activeNodes.find(n => n.id === target.itemId);
            if (el && (el.innerText || '').length > 5) return true;
          }

          // 2. Kiểm tra theo URL sản phẩm
          if (target.productUrl) {
            const cleanUrl = target.productUrl.split('?')[0].replace('https://www.lazada.vn', '').replace('http://www.lazada.vn', '');
            if (cleanUrl.length > 5) {
              const matched = activeNodes.some(n => !!n.querySelector(`a[href*="${cleanUrl}"]`));
              if (matched) return true;
            }
          }

          // 3. Kiểm tra theo tên sản phẩm (30 ký tự đầu tiên)
          if (target.productName) {
            const shortName = target.productName.slice(0, 30).toLowerCase();
            const matched = activeNodes.some(n => (n.innerText || '').toLowerCase().includes(shortName));
            if (matched) return true;
          }

          return false;
        }, { itemId: targetItem.itemId, productUrl: targetItem.productUrl, productName: targetItem.productName });
      };

      let isStillInCart = await checkItemStillInCart();
      if (isStillInCart) {
        console.log('[AutoOrder] ⚠️ Sản phẩm vẫn hiển thị trong giỏ hàng, tải lại giỏ hàng nhanh để xác minh lại...');
        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        isStillInCart = await checkItemStillInCart();
      }

      if (isStillInCart) {
        throw new Error(`Sản phẩm "${targetItem.productName}" vẫn còn trong giỏ hàng sau khi thao tác đặt hàng.`);
      }

      console.log(`[AutoOrder] 🎉 XÁC THỰC THÀNH CÔNG: Sản phẩm "${targetItem.productName}" đã rời khỏi giỏ hàng! Đơn hàng đã đặt thành công.`);
      this.orderedProductKeys.add(targetItem.productKey);

      // Ghi log đơn đặt hàng
      const orderLog = addLogEntry({
        cycleId: this.cycleCount,
        productName: `[ĐÃ ĐẶT HÀNG] ${targetItem.productName}`,
        productUrl: targetItem.productUrl,
        currentPrice: targetItem.currentPrice,
        quantity: targetItem.quantity || 1,
        threshold: threshold,
        status: 'ORDER_PLACED',
        isNewAlert: true,
        audioStatus: 'PLAYING',
        telegramStatus: config.telegram?.enabled ? 'PENDING' : 'DISABLED',
        errorMessage: `Tự động đặt hàng thành công! Đã xử lý thanh toán và xác nhận sản phẩm đã được mua khỏi giỏ hàng.`
      });

      // Gửi thông báo Telegram
      if (config.telegram?.enabled && config.telegram?.botToken && config.telegram?.chatId) {
        const orderMsg = formatOrderSuccessMessage(targetItem, threshold);
        sendTelegramMessage(config.telegram.botToken, config.telegram.chatId, orderMsg)
          .then(res => {
            if (res.success && orderLog?.id) {
              updateLogTelegramStatus(orderLog.id, 'SENT');
            }
          })
          .catch(e => console.error('[AutoOrder] Lỗi gửi tin Telegram đặt hàng:', e.message));
      }

      this.emitState({
        type: 'ORDER_PLACED',
        product: targetItem,
        message: `🎉 Tự động đặt hàng thành công: ${targetItem.productName}!`
      });

    } catch (err) {
      console.error(`[AutoOrder] ❌ Lỗi đặt hàng ở lần thử ${attempt}/${MAX_ORDER_ATTEMPTS}: ${err.message}`);

      // CƠ CHẾ THỬ LẠI TỨC THỜI (Instant Retry): Kích hoạt vòng lặp thử lại ngay lập tức không chờ đợi
      if (attempt < MAX_ORDER_ATTEMPTS && this.isRunning && !this.isStopping) {
        console.log(`[AutoOrder] 🔄 [INSTANT RETRY] THAO TÁC ĐẶT LẠI NGAY LẬP TỨC (Lần thử ${attempt + 1}/${MAX_ORDER_ATTEMPTS})...`);
        this.emitState({
          message: `⚠️ Lỗi: ${err.message}. Đang đặt lại ngay lập tức (Lần ${attempt + 1}/${MAX_ORDER_ATTEMPTS})...`
        });

        // Nhanh chóng đưa trang về giỏ hàng để thao tác lại ngay lập tức (domcontentloaded)
        try {
          await this.page.goto(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (e) {}

        // GỌI ĐẶT LẠI NGAY TỨC THÌ
        return await this.performAutoOrder(targetItem, threshold, config, attempt + 1);
      }

      // Đã thử hết số lần tối đa mà vẫn thất bại
      console.error(`[AutoOrder] ❌ Đã thử ${MAX_ORDER_ATTEMPTS} lần thất bại. Ghi nhận lỗi và báo cáo.`);
      try {
        const errPath = path.join(__dirname, '..', 'public', 'debug-order-error.png');
        await this.page.screenshot({ path: errPath, fullPage: true });
      } catch (scErr) {}

      addLogEntry({
        cycleId: this.cycleCount,
        productName: `[LỖI ĐẶT HÀNG] ${targetItem.productName}`,
        productUrl: targetItem.productUrl,
        currentPrice: targetItem.currentPrice,
        quantity: targetItem.quantity || 1,
        threshold: threshold,
        status: 'ERROR',
        isNewAlert: false,
        audioStatus: '—',
        telegramStatus: config.telegram?.enabled ? 'PENDING' : 'DISABLED',
        errorMessage: `Lỗi đặt hàng tự động sau ${MAX_ORDER_ATTEMPTS} lần thử: ${err.message}`
      });

      if (config.telegram?.enabled && config.telegram?.botToken && config.telegram?.chatId) {
        const errorMsg = `⚠️ <b>LỖI TỰ ĐỘNG ĐẶT HÀNG LAZADA</b>\n\n` +
          `• <b>Sản phẩm:</b> ${targetItem.productName}\n` +
          `• <b>Lỗi:</b> Đã thử ${MAX_ORDER_ATTEMPTS} lần nhưng thất bại: ${err.message}\n` +
          `• <b>Thời điểm:</b> ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
        sendTelegramMessage(config.telegram.botToken, config.telegram.chatId, errorMsg).catch(() => {});
      }

      try {
        await this.page.goto(targetCartUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch (e) {}
    } finally {
      try {
        if (this.page && onResponseHandler) {
          this.page.off('response', onResponseHandler);
        }
      } catch (e) {}
      if (attempt === 1) {
        this.isOrdering = false;
      }
    }
  }
}

module.exports = LazadaPriceMonitor;
