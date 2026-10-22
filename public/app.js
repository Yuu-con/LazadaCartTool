// Lazada Price Monitor Dashboard Frontend Logic
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const systemStatusBadge = document.getElementById('systemStatusBadge');
  const systemStatusText = document.getElementById('systemStatusText');
  const alertBanner = document.getElementById('alertBanner');
  const alertProductList = document.getElementById('alertProductList');
  const alertCountdown = document.getElementById('alertCountdown');
  const btnStopAudio = document.getElementById('btnStopAudio');

  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnTestAudio = document.getElementById('btnTestAudio');

  const configForm = document.getElementById('configForm');
  const cartUrlInput = document.getElementById('cartUrl');
  const priceThresholdInput = document.getElementById('priceThreshold');
  const checkIntervalInput = document.getElementById('checkIntervalSeconds');
  const repeatAlertCheckbox = document.getElementById('repeatAlertOnSameLowPrice');
  const maxLogEntriesInput = document.getElementById('maxLogEntries');

  const telegramEnabled = document.getElementById('telegramEnabled');
  const telegramFields = document.getElementById('telegramFields');
  const telegramBotToken = document.getElementById('telegramBotToken');
  const telegramChatId = document.getElementById('telegramChatId');
  const telegramBatch = document.getElementById('telegramBatch');
  const btnToggleToken = document.getElementById('btnToggleToken');
  const btnTestTelegram = document.getElementById('btnTestTelegram');
  const telegramTestResult = document.getElementById('telegramTestResult');
  const saveConfigMsg = document.getElementById('saveConfigMsg');

  const statCycle = document.getElementById('statCycle');
  const statScanned = document.getElementById('statScanned');
  const statAlertCount = document.getElementById('statAlertCount');
  const statNextCycle = document.getElementById('statNextCycle');
  const monitorLiveMsg = document.getElementById('monitorLiveMsg');

  const logTableBody = document.getElementById('logTableBody');
  const filterStatus = document.getElementById('filterStatus');
  const filterProductName = document.getElementById('filterProductName');
  const btnApplyFilter = document.getElementById('btnApplyFilter');
  const btnResetFilter = document.getElementById('btnResetFilter');
  const btnExportCSV = document.getElementById('btnExportCSV');
  const btnExportJSON = document.getElementById('btnExportJSON');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const btnAutoCleanLogs = document.getElementById('btnAutoCleanLogs');
  const logCountBadge = document.getElementById('logCountBadge');

  // Khởi tạo Audio Manager
  const audioManager = new window.AlertAudioManager({
    maxDurationSeconds: 30,
    onTick: (seconds) => {
      if (alertCountdown) alertCountdown.textContent = seconds;
    },
    onStop: (reason) => {
      console.log('[Dashboard] Audio stopped:', reason);
      // Gửi thông báo đến server để cập nhật log audioStatus
      fetch('/api/audio-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: reason })
      }).catch(() => {});
    }
  });

  // Toggle ẩn hiện trường Telegram
  function updateTelegramVisibility() {
    telegramFields.style.display = telegramEnabled.checked ? 'block' : 'none';
  }
  telegramEnabled.addEventListener('change', updateTelegramVisibility);

  // Toggle xem Bot Token
  btnToggleToken.addEventListener('click', () => {
    if (telegramBotToken.type === 'password') {
      telegramBotToken.type = 'text';
      btnToggleToken.textContent = '🔒 Ẩn token';
    } else {
      telegramBotToken.type = 'password';
      btnToggleToken.textContent = '👁️ Hiện/Ẩn token';
    }
  });

  // Tải cấu hình hiện tại từ backend
  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      if (cartUrlInput) cartUrlInput.value = cfg.cartUrl || 'https://cart.lazada.vn/cart';
      priceThresholdInput.value = cfg.priceThreshold || 550000;
      checkIntervalInput.value = cfg.checkIntervalSeconds || 60;
      repeatAlertCheckbox.checked = !!cfg.repeatAlertOnSameLowPrice;
      const autoOrderCb = document.getElementById('autoOrder');
      if (autoOrderCb) autoOrderCb.checked = cfg.autoOrder !== false;
      if (maxLogEntriesInput) maxLogEntriesInput.value = cfg.maxLogEntries || 500;

      if (cfg.telegram) {
        telegramEnabled.checked = !!cfg.telegram.enabled;
        telegramBotToken.value = cfg.telegram.botToken || '';
        telegramChatId.value = cfg.telegram.chatId || '';
        telegramBatch.checked = cfg.telegram.batchNotifications !== false;
      }
      updateTelegramVisibility();
    } catch (e) {
      console.error('Lỗi nạp config:', e);
    }
  }

  // Lưu cấu hình
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveConfigMsg.textContent = 'Đang lưu...';
    saveConfigMsg.style.color = '#0070f3';

    const autoOrderCb = document.getElementById('autoOrder');
    const payload = {
      cartUrl: cartUrlInput ? cartUrlInput.value.trim() : 'https://cart.lazada.vn/cart',
      priceThreshold: parseInt(priceThresholdInput.value, 10),
      checkIntervalSeconds: parseInt(checkIntervalInput.value, 10),
      repeatAlertOnSameLowPrice: repeatAlertCheckbox.checked,
      autoOrder: autoOrderCb ? autoOrderCb.checked : true,
      maxLogEntries: maxLogEntriesInput ? (parseInt(maxLogEntriesInput.value, 10) || 500) : 500,
      telegram: {
        enabled: telegramEnabled.checked,
        botToken: telegramBotToken.value.trim(),
        chatId: telegramChatId.value.trim(),
        batchNotifications: telegramBatch.checked
      }
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        saveConfigMsg.textContent = '✅ Đã lưu cấu hình!';
        saveConfigMsg.style.color = '#16a34a';
        setTimeout(() => { saveConfigMsg.textContent = ''; }, 3000);
      } else {
        throw new Error('Lỗi server');
      }
    } catch (err) {
      saveConfigMsg.textContent = '❌ Lỗi khi lưu cấu hình';
      saveConfigMsg.style.color = '#dc2626';
    }
  });

  // Gửi thông báo thử Telegram
  btnTestTelegram.addEventListener('click', async () => {
    telegramTestResult.textContent = 'Đang gửi...';
    telegramTestResult.style.color = '#0284c7';

    try {
      const res = await fetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: telegramBotToken.value.trim(),
          chatId: telegramChatId.value.trim()
        })
      });
      const data = await res.json();
      if (data.success) {
        if (data.total && data.total > 1) {
          telegramTestResult.textContent = `✅ Đã gửi thành công đến ${data.sentCount}/${data.total} Chat ID!`;
        } else {
          telegramTestResult.textContent = '✅ Đã gửi thành công đến Telegram!';
        }
        telegramTestResult.style.color = '#16a34a';
      } else {
        telegramTestResult.textContent = `❌ Thất bại: ${data.error}`;
        telegramTestResult.style.color = '#dc2626';
      }
    } catch (err) {
      telegramTestResult.textContent = `❌ Lỗi mạng: ${err.message}`;
      telegramTestResult.style.color = '#dc2626';
    }
  });

  // Nút DỪNG THÔNG BÁO (Tắt còi)
  btnStopAudio.addEventListener('click', () => {
    audioManager.stopAlert('STOPPED');
    // Chỉ ẩn banner hoặc tắt animation mà không xóa danh sách sản phẩm
    alertCountdown.textContent = '0 (Đã dừng)';
  });

  // Nút Kiểm tra âm thanh
  btnTestAudio.addEventListener('click', () => {
    audioManager.testBeep();
  });

  // Nút mở trang đăng nhập Lazada & Quét QR
  const btnOpenLogin = document.getElementById('btnOpenLogin');
  const loginNoticeBox = document.getElementById('loginNoticeBox');
  const loginQrImg = document.getElementById('loginQrImg');
  const qrLoadingText = document.getElementById('qrLoadingText');
  const loginCheckStatus = document.getElementById('loginCheckStatus');
  const btnRefreshQr = document.getElementById('btnRefreshQr');
  const btnCloseLoginBox = document.getElementById('btnCloseLoginBox');
  const btnBringBrowser = document.getElementById('btnBringBrowser');
  const btnAutoSolveCaptcha = document.getElementById('btnAutoSolveCaptcha');
  const captchaWarningBanner = document.getElementById('captchaWarningBanner');
  let loginPollTimer = null;

  // Bắt đầu giám sát (chỉ chạy khi thực sự đã đăng nhập)
  btnStart.addEventListener('click', async () => {
    audioManager.initContext();
    btnStart.disabled = true;

    try {
      const res = await fetch('/api/monitor/start', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        btnStart.disabled = false;
        if (data.isLoginNeeded) {
          alert('⚠️ Bạn chưa đăng nhập tài khoản Lazada!\nHãy quét mã QR hoặc đăng nhập trên trình duyệt trước khi bắt đầu giám sát.');
          loadAndShowQr();
        } else {
          alert('Không thể bắt đầu: ' + (data.error || data.message || 'Lỗi không xác định'));
        }
      } else {
        // Đã bắt đầu thành công -> Ẩn khung login nếu đang mở
        if (loginNoticeBox) loginNoticeBox.style.display = 'none';
        if (loginPollTimer) {
          clearInterval(loginPollTimer);
          loginPollTimer = null;
        }
      }
    } catch (e) {
      console.error(e);
      btnStart.disabled = false;
    }
  });

  async function loadAndShowQr() {
    if (loginNoticeBox) loginNoticeBox.style.display = 'block';
    if (qrLoadingText) {
      qrLoadingText.style.display = 'block';
      qrLoadingText.textContent = 'Đang kết nối tới trang đăng nhập Lazada...';
    }
    if (loginQrImg) loginQrImg.style.display = 'none';
    if (loginCheckStatus) {
      loginCheckStatus.textContent = '⏳ Đang tải mã QR hoặc trang đăng nhập...';
      loginCheckStatus.style.color = '#9a3412';
    }

    try {
      const res = await fetch('/api/monitor/open-login', { method: 'POST' });
      const data = await res.json();
      if (data.success && data.qrImage) {
        if (loginQrImg) {
          loginQrImg.src = data.qrImage;
          loginQrImg.style.display = 'inline-block';
        }
        if (qrLoadingText) qrLoadingText.style.display = 'none';
        if (loginCheckStatus) loginCheckStatus.textContent = '📱 Hãy dùng App Lazada quét mã QR trên hoặc đăng nhập tài khoản';
        startLoginPolling();
      } else {
        if (qrLoadingText) qrLoadingText.textContent = 'Chưa tải được QR: ' + (data.error || 'Vui lòng thử lại');
      }
    } catch (err) {
      if (qrLoadingText) qrLoadingText.textContent = 'Lỗi kết nối: ' + err.message;
    }
  }

  function startLoginPolling() {
    if (loginPollTimer) clearInterval(loginPollTimer);
    loginPollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/monitor/check-login');
        const data = await res.json();

        // Cập nhật cảnh báo thanh trượt chống bot
        if (captchaWarningBanner) {
          captchaWarningBanner.style.display = data.hasCaptcha ? 'block' : 'none';
        }

        // Cập nhật ảnh chụp màn hình mới nhất
        if (data.qrImage && loginQrImg && loginNoticeBox && loginNoticeBox.style.display !== 'none') {
          loginQrImg.src = data.qrImage;
          loginQrImg.style.display = 'inline-block';
          if (qrLoadingText) qrLoadingText.style.display = 'none';
        }

        if (data.loggedIn) {
          if (loginCheckStatus) {
            loginCheckStatus.innerHTML = `🎉 <strong>ĐÃ ĐĂNG NHẬP THÀNH CÔNG!</strong> Tài khoản: <strong>${data.accountName || 'Lazada'}</strong>.<br>👉 Bấm nút <strong>"▶️ BẮT ĐẦU GIÁM SÁT"</strong> để tiến hành quét giỏ hàng.`;
            loginCheckStatus.style.color = '#15803d';
          }
          // TUYỆT ĐỐI KHÔNG TỰ ĐỘNG ẨN KHUNG ĐĂNG NHẬP HOẶC TỰ ĐỘNG CHẠY
          // Người dùng chủ động kiểm tra xong rồi bấm nút "Bắt đầu giám sát"
        } else {
          if (loginCheckStatus && !data.hasCaptcha) {
            loginCheckStatus.innerHTML = '⏳ Đang đợi quét mã QR hoặc đăng nhập trên trình duyệt...';
            loginCheckStatus.style.color = '#9a3412';
          }
        }
      } catch (e) {}
    }, 3000);
  }

  // Tương tác chuột trên hình ảnh: Hỗ trợ cả Click và Kéo trượt (Drag)
  if (loginQrImg) {
    loginQrImg.style.cursor = 'crosshair';
    loginQrImg.title = 'Nhấn giữ và kéo chuột để gạt thanh trượt chống bot, hoặc click để thao tác!';

    // Chặn kéo hình mặc định của trình duyệt
    loginQrImg.addEventListener('dragstart', (e) => e.preventDefault());

    let dragStartPos = null;

    loginQrImg.addEventListener('mousedown', (e) => {
      const rect = loginQrImg.getBoundingClientRect();
      const scaleX = loginQrImg.naturalWidth / rect.width;
      const scaleY = loginQrImg.naturalHeight / rect.height;
      dragStartPos = {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
      };
    });

    loginQrImg.addEventListener('mouseup', async (e) => {
      if (!dragStartPos) return;
      const rect = loginQrImg.getBoundingClientRect();
      const scaleX = loginQrImg.naturalWidth / rect.width;
      const scaleY = loginQrImg.naturalHeight / rect.height;
      const endX = Math.round((e.clientX - rect.left) * scaleX);
      const endY = Math.round((e.clientY - rect.top) * scaleY);

      const dx = Math.abs(endX - dragStartPos.x);
      const dy = Math.abs(endY - dragStartPos.y);

      if (dx > 25 || dy > 25) {
        // Thao tác Kéo chuột (Drag)
        if (loginCheckStatus) loginCheckStatus.textContent = `⏳ Đang kéo chuột từ (${dragStartPos.x}, ${dragStartPos.y}) sang (${endX}, ${endY})...`;
        try {
          const res = await fetch('/api/monitor/drag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              startX: dragStartPos.x,
              startY: dragStartPos.y,
              endX: endX,
              endY: endY
            })
          });
          const data = await res.json();
          if (data.success && data.qrImage) {
            loginQrImg.src = data.qrImage;
            if (loginCheckStatus) loginCheckStatus.textContent = '✅ Đã thực hiện thao tác kéo thanh trượt!';
          }
        } catch (err) {
          if (loginCheckStatus) loginCheckStatus.textContent = 'Lỗi kéo: ' + err.message;
        }
      } else {
        // Thao tác Bấm chuột (Click)
        if (loginCheckStatus) loginCheckStatus.textContent = `⏳ Đang bấm chuột tại (${endX}, ${endY})...`;
        try {
          const res = await fetch('/api/monitor/click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x: endX, y: endY })
          });
          const data = await res.json();
          if (data.success && data.qrImage) {
            loginQrImg.src = data.qrImage;
            if (loginCheckStatus) loginCheckStatus.textContent = '✅ Đã bấm chuột vào trang!';
          }
        } catch (err) {
          if (loginCheckStatus) loginCheckStatus.textContent = 'Lỗi bấm: ' + err.message;
        }
      }
      dragStartPos = null;
    });
  }

  // Nút mở trình duyệt ra màn hình
  if (btnBringBrowser) {
    btnBringBrowser.addEventListener('click', async () => {
      try {
        await fetch('/api/monitor/bring-to-front', { method: 'POST' });
      } catch (e) {}
    });
  }

  // Nút tự động kéo thanh trượt chống bot
  if (btnAutoSolveCaptcha) {
    btnAutoSolveCaptcha.addEventListener('click', async () => {
      if (loginCheckStatus) loginCheckStatus.textContent = '⏳ Đang tự động tìm và kéo thanh trượt...';
      try {
        const res = await fetch('/api/monitor/solve-captcha', { method: 'POST' });
        const data = await res.json();
        if (data.qrImage && loginQrImg) {
          loginQrImg.src = data.qrImage;
        }
        if (data.solved) {
          if (loginCheckStatus) loginCheckStatus.textContent = '✅ Đã tự động kéo thanh trượt thành công!';
        } else {
          if (loginCheckStatus) loginCheckStatus.textContent = '⚠️ Không tìm thấy thanh trượt hoặc chưa giải được. Hãy kéo thủ công trên hình!';
        }
      } catch (err) {
        if (loginCheckStatus) loginCheckStatus.textContent = 'Lỗi: ' + err.message;
      }
    });
  }

  if (btnCloseLoginBox) {
    btnCloseLoginBox.addEventListener('click', () => {
      if (loginNoticeBox) loginNoticeBox.style.display = 'none';
      if (loginPollTimer) {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
      }
    });
  }

  if (btnOpenLogin) {
    btnOpenLogin.addEventListener('click', () => {
      loadAndShowQr();
    });
  }

  if (btnRefreshQr) {
    btnRefreshQr.addEventListener('click', () => {
      loadAndShowQr();
    });
  }

  // Dừng giám sát
  btnStop.addEventListener('click', async () => {
    btnStop.disabled = true;
    try {
      await fetch('/api/monitor/stop', { method: 'POST' });
    } catch (e) {
      console.error(e);
      btnStop.disabled = false;
    }
  });

  // Cập nhật giao diện trạng thái hệ thống
  function updateStateUI(data) {
    const state = data.state || 'STOPPED';
    systemStatusBadge.className = 'header-status-badge';

    if (state === 'RUNNING') {
      systemStatusBadge.classList.add('running');
      systemStatusText.textContent = 'Đang giám sát';
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else if (state === 'RELOADING') {
      systemStatusBadge.classList.add('reloading');
      systemStatusText.textContent = 'Đang tải lại trang';
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else if (state === 'WAITING_LOGIN') {
      systemStatusBadge.classList.add('reloading');
      systemStatusText.textContent = 'Chờ đăng nhập Lazada';
      btnStart.disabled = true;
      btnStop.disabled = false;
    } else if (state === 'ERROR') {
      systemStatusBadge.classList.add('alert');
      systemStatusText.textContent = 'Gặp lỗi';
      btnStart.disabled = false;
      btnStop.disabled = false;
    } else {
      systemStatusText.textContent = 'Đã dừng';
      btnStart.disabled = false;
      btnStop.disabled = true;
    }

    if (data.cycleCount !== undefined) {
      statCycle.textContent = data.cycleCount;
    }

    if (data.scannedCount !== undefined) {
      statScanned.textContent = data.scannedCount;
    }

    if (data.alertCount !== undefined) {
      statAlertCount.textContent = data.alertCount;
    }

    if (data.message) {
      monitorLiveMsg.textContent = data.message;
    }

    if (data.nextCycleIn !== undefined) {
      let remaining = data.nextCycleIn;
      statNextCycle.textContent = `${remaining}s`;
      if (window.nextCycleInterval) clearInterval(window.nextCycleInterval);
      window.nextCycleInterval = setInterval(() => {
        remaining--;
        if (remaining >= 0) {
          statNextCycle.textContent = `${remaining}s`;
        } else {
          clearInterval(window.nextCycleInterval);
          statNextCycle.textContent = 'Đang quét...';
        }
      }, 1000);
    }
  }

  // Tải danh sách Logs
  async function fetchLogs() {
    try {
      const params = new URLSearchParams();
      if (filterStatus.value !== 'ALL') params.append('status', filterStatus.value);
      if (filterProductName.value.trim()) params.append('productName', filterProductName.value.trim());

      const res = await fetch(`/api/logs?${params.toString()}`);
      const logs = await res.json();
      renderLogs(logs);
    } catch (e) {
      console.error('Lỗi tải logs:', e);
    }
  }

  function renderLogs(logs) {
    if (logCountBadge) {
      logCountBadge.textContent = `${logs ? logs.length : 0} bản ghi`;
    }

    if (!logs || logs.length === 0) {
      logTableBody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">Không có bản ghi nhật ký phù hợp.</td></tr>`;
      return;
    }

    // Cập nhật số liệu thống kê sản phẩm nếu chưa có từ websocket
    if ((statScanned.textContent === '0' || !statScanned.textContent) && logs.length > 0) {
      const latestSummary = logs.find(l => l.status === 'SUCCESS' && l.quantity);
      if (latestSummary) {
        statScanned.textContent = latestSummary.quantity;
      }
    }
    if ((statAlertCount.textContent === '0' || !statAlertCount.textContent) && logs.length > 0) {
      const latestCycleId = logs[0].cycleId;
      const latestAlerts = logs.filter(l => l.cycleId === latestCycleId && l.status === 'ALERT').length;
      statAlertCount.textContent = latestAlerts;
    }

    let html = '';
    logs.forEach(l => {
      const timeStr = new Date(l.timestamp).toLocaleTimeString('vi-VN');
      const isAlert = l.status === 'ALERT';
      const isSuccess = l.status === 'SUCCESS';
      const isError = l.status === 'ERROR';
      const isOrderPlaced = l.status === 'ORDER_PLACED';

      let statusBadge = '';
      if (isSuccess) statusBadge = '<span class="badge badge-success">SUCCESS</span>';
      else if (isOrderPlaced) statusBadge = '<span class="badge" style="background:#7c3aed;color:#fff;font-weight:bold;">⚡ ĐÃ ĐẶT HÀNG</span>';
      else if (isAlert) statusBadge = '<span class="badge badge-alert">ALERT (Giá thấp)</span>';
      else if (isError) statusBadge = '<span class="badge badge-error">ERROR</span>';
      else if (l.status === 'NORMAL') statusBadge = '<span class="badge badge-normal">NORMAL</span>';
      else statusBadge = `<span class="badge badge-unknown">${escapeHtml(l.status || 'UNKNOWN')}</span>`;

      // Cột giá hiện tại và ngưỡng cảnh báo
      let priceText = '—';
      let thresholdText = l.threshold ? `${Number(l.threshold).toLocaleString('vi-VN')} ₫` : '—';
      if (isAlert || isOrderPlaced) {
        priceText = l.currentPrice !== null && l.currentPrice !== undefined
          ? `<span class="price-alert-highlight">${Number(l.currentPrice).toLocaleString('vi-VN')} ₫</span>`
          : '<span class="text-muted">Chưa rõ</span>';
      } else if (!isSuccess && !isError) {
        priceText = l.currentPrice !== null && l.currentPrice !== undefined
          ? `${Number(l.currentPrice).toLocaleString('vi-VN')} ₫`
          : '<span class="text-muted">Chưa rõ</span>';
      }

      // Cột Tên sản phẩm
      let nameHtml = '';
      if (isSuccess) {
        nameHtml = '<strong>Tổng kết chu kỳ</strong>';
      } else if (l.productUrl) {
        nameHtml = `<a href="${l.productUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.productName)}</a>`;
      } else {
        nameHtml = escapeHtml(l.productName);
      }

      // Cột Âm thanh & Android
      const audioText = (isSuccess || isError) ? '—' : (l.audioStatus || 'N/A');
      const androidText = (isSuccess || isError) ? '—' : (l.telegramStatus || 'N/A');

      // Cột Chi tiết / Lỗi
      let detailHtml = '';
      if (isSuccess) {
        detailHtml = `<span style="color: #166534; font-weight: 500;">${escapeHtml(l.errorMessage || `Đã kiểm tra ${l.quantity || 0} sản phẩm, không có sản phẩm nào đạt ngưỡng cảnh báo.`)}</span>`;
      } else if (isOrderPlaced) {
        detailHtml = `<span style="color: #7c3aed; font-weight: 600;">${escapeHtml(l.errorMessage || 'Tự động tích chọn, bấm Thanh toán và Đặt hàng thành công!')}</span>`;
      } else if (isError) {
        detailHtml = `<span style="color: #991b1b; font-weight: 500;">${escapeHtml(l.errorMessage || 'Lỗi kiểm tra')}</span>`;
      } else if (isAlert) {
        detailHtml = `<small class="text-muted">${escapeHtml(l.errorMessage || 'Dưới ngưỡng cảnh báo')}</small>`;
      } else {
        detailHtml = `<small class="text-muted">${escapeHtml(l.errorMessage || 'Đạt yêu cầu')}</small>`;
      }

      html += `
        <tr>
          <td>${timeStr}</td>
          <td>#${l.cycleId}</td>
          <td title="${escapeHtml(l.productName)}">${nameHtml}</td>
          <td>${priceText}</td>
          <td>${thresholdText}</td>
          <td>${statusBadge}</td>
          <td>${audioText}</td>
          <td>${androidText}</td>
          <td>${detailHtml}</td>
        </tr>
      `;
    });

    logTableBody.innerHTML = html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Kết nối WebSocket Realtime với Server
  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      console.log('[WebSocket] Đã kết nối với máy chủ theo dõi');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'MONITOR_STATE') {
          updateStateUI(msg);
          if (msg.state === 'WAITING_LOGIN') {
            if (loginNoticeBox) loginNoticeBox.style.display = 'block';
            if (qrLoadingText) qrLoadingText.style.display = 'none';
            if (loginQrImg) {
              loginQrImg.src = msg.qrImage || ('/login-qr.png?t=' + Date.now());
              loginQrImg.style.display = 'inline-block';
            }
            if (loginCheckStatus) {
              loginCheckStatus.textContent = '📱 Hệ thống đang ở trang đăng nhập Lazada! Hãy quét mã QR trên bằng App Lazada';
              loginCheckStatus.style.color = '#c2410c';
            }
            startLoginPolling();
          }
          fetchLogs();
        } else if (msg.type === 'LOGIN_REQUIRED') {
          updateStateUI(msg);
          if (loginNoticeBox) loginNoticeBox.style.display = 'block';
          if (qrLoadingText) qrLoadingText.style.display = 'none';
          if (loginQrImg) {
            loginQrImg.src = msg.qrImage || ('/login-qr.png?t=' + Date.now());
            loginQrImg.style.display = 'inline-block';
          }
          if (loginCheckStatus) {
            loginCheckStatus.textContent = '📱 Hệ thống đã tự động mở trang đăng nhập! Hãy quét mã QR trên bằng App Lazada';
            loginCheckStatus.style.color = '#c2410c';
          }
          startLoginPolling();
          fetchLogs();
        } else if (msg.type === 'TRIGGER_ALERT') {
          handleTriggerAlert(msg);
          fetchLogs();
        } else if (msg.type === 'ORDER_PLACED') {
          if (monitorLiveMsg) monitorLiveMsg.textContent = msg.message || '🎉 Đã tự động đặt hàng thành công!';
          fetchLogs();
        } else if (msg.type === 'CONFIG_UPDATED') {
          loadConfig();
        } else if (msg.type === 'LOGS_CLEANED' || msg.type === 'LOGS_UPDATED') {
          fetchLogs();
        }
      } catch (e) {
        console.error('[WebSocket] Lỗi xử lý tin nhắn:', e);
      }
    };

    ws.onclose = () => {
      console.log('[WebSocket] Mất kết nối. Đang thử kết nối lại sau 3 giây...');
      setTimeout(connectWebSocket, 3000);
    };
  }

  // Xử lý sự kiện phát hiện giá thấp
  function handleTriggerAlert(msg) {
    alertBanner.style.display = 'block';

    const items = msg.newAlertItems || [];
    let itemsHtml = '';
    items.forEach(it => {
      const priceFmt = it.currentPrice ? `${it.currentPrice.toLocaleString('vi-VN')} ₫` : '';
      const link = it.productUrl
        ? `<a href="${it.productUrl}" target="_blank">${escapeHtml(it.productName)}</a>`
        : escapeHtml(it.productName);
      itemsHtml += `<div class="alert-product-item">🔔 ${link} - <strong>${priceFmt}</strong></div>`;
    });
    alertProductList.innerHTML = itemsHtml;

    // Kích hoạt còi âm thanh 30s
    audioManager.startAlert();
  }

  // Lọc log
  btnApplyFilter.addEventListener('click', fetchLogs);
  btnResetFilter.addEventListener('click', () => {
    filterStatus.value = 'ALL';
    filterProductName.value = '';
    fetchLogs();
  });

  // Xuất CSV
  btnExportCSV.addEventListener('click', () => {
    window.open('/api/logs/export/csv', '_blank');
  });

  // Xuất JSON
  btnExportJSON.addEventListener('click', () => {
    window.open('/api/logs/export/json', '_blank');
  });

  // Tự động xóa bớt log cũ
  if (btnAutoCleanLogs) {
    btnAutoCleanLogs.addEventListener('click', async () => {
      try {
        btnAutoCleanLogs.disabled = true;
        btnAutoCleanLogs.textContent = '⏳ Đang dọn...';
        const res = await fetch('/api/logs/auto-clean', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert(`✅ ${data.message}`);
          fetchLogs();
        } else {
          alert('❌ Lỗi: ' + (data.error || 'Không thể dọn dẹp log'));
        }
      } catch (e) {
        alert('❌ Lỗi kết nối: ' + e.message);
      } finally {
        btnAutoCleanLogs.disabled = false;
        btnAutoCleanLogs.textContent = '🧹 Tự xóa log cũ';
      }
    });
  }

  // Xóa log
  btnClearLogs.addEventListener('click', async () => {
    if (confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử quét không?')) {
      await fetch('/api/logs', { method: 'DELETE' });
      fetchLogs();
    }
  });

  // Khởi chạy ban đầu
  loadConfig();
  fetchLogs();
  connectWebSocket();
});
