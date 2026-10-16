const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'history.json');
const DEFAULT_MAX_LOG_ENTRIES = 500;

function ensureDataDir() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

/**
 * Lấy cấu hình liên quan đến nhật ký
 */
function getLogConfig() {
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    return {
      maxEntries: cfg.maxLogEntries || DEFAULT_MAX_LOG_ENTRIES,
      logRetentionDays: cfg.logRetentionDays || 3,
      autoCleanNormalLogs: cfg.autoCleanNormalLogs !== false,
      onlyAlerts: cfg.onlyAlerts !== false
    };
  } catch (e) {
    return {
      maxEntries: DEFAULT_MAX_LOG_ENTRIES,
      logRetentionDays: 3,
      autoCleanNormalLogs: true,
      onlyAlerts: true
    };
  }
}

/**
 * Thuật toán tự động cắt tỉa / xóa bớt logs khi quá nhiều hoặc quá cũ
 * @param {Array} logs - Danh sách log (sắp xếp mới nhất ở đầu)
 * @param {Object} options - { maxEntries, logRetentionDays, autoCleanNormalLogs, onlyAlerts }
 * @returns {{ trimmedLogs: Array, removedCount: number }}
 */
function trimLogs(logs, options = {}) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return { trimmedLogs: [], removedCount: 0 };
  }

  const initialCount = logs.length;
  let currentLogs = [...logs];

  // 1. Người dùng yêu cầu: Nếu log không khớp với ngưỡng giá tồn tại thì hãy xóa log đó đi
  // Giữ lại các log hợp lệ: ALERT, ORDER_PLACED, SUCCESS, ERROR hệ thống; xóa mọi log riêng lẻ NORMAL / UNKNOWN
  if (options.onlyAlerts) {
    currentLogs = currentLogs.filter(item => item.status === 'ALERT' || item.status === 'ORDER_PLACED' || item.status === 'SUCCESS' || item.status === 'ERROR');
  }

  const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : DEFAULT_MAX_LOG_ENTRIES;
  const retentionDays = Number(options.logRetentionDays) > 0 ? Number(options.logRetentionDays) : 3;
  const autoCleanNormal = options.autoCleanNormalLogs !== false;

  // 2. Tự động xóa các log quá cũ (vượt quá số ngày lưu trữ)
  const now = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  currentLogs = currentLogs.filter(item => {
    const itemTime = new Date(item.timestamp).getTime();
    if (isNaN(itemTime)) return true;
    return (now - itemTime) <= maxAgeMs;
  });

  // 3. Nếu số lượng log vượt quá giới hạn tối đa (maxEntries):
  if (currentLogs.length > maxEntries) {
    if (autoCleanNormal) {
      // Ưu tiên cao: Giữ lại các log ALERT / ORDER_PLACED (giá giảm và đơn đặt hàng),
      // Xóa các log NORMAL / UNKNOWN cũ trước cho đến khi tổng số log <= maxEntries
      const alerts = [];
      const nonAlerts = [];

      for (const item of currentLogs) {
        if (item.status === 'ALERT' || item.status === 'ORDER_PLACED') {
          alerts.push(item);
        } else {
          nonAlerts.push(item);
        }
      }

      // Số lượng log thông thường được giữ lại
      const allowedNonAlerts = Math.max(0, maxEntries - alerts.length);
      const keptNonAlerts = nonAlerts.slice(0, allowedNonAlerts);

      // Ghép lại và sắp xếp lại theo thời gian giảm dần (mới nhất lên đầu)
      currentLogs = [...alerts, ...keptNonAlerts].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      // Nếu vẫn còn vượt quá (kể cả khi chỉ còn ALERT), cắt bớt phần đuôi cũ nhất
      if (currentLogs.length > maxEntries) {
        currentLogs = currentLogs.slice(0, maxEntries);
      }
    } else {
      // Cắt tỉa đơn giản theo thứ tự cũ nhất
      currentLogs = currentLogs.slice(0, maxEntries);
    }
  }

  const removedCount = initialCount - currentLogs.length;
  return { trimmedLogs: currentLogs, removedCount };
}

/**
 * Đọc toàn bộ danh sách logs từ history.json
 * Sắp xếp log mới nhất lên đầu tiên
 */
function getLogs(filter = {}) {
  try {
    ensureDataDir();
    if (!fs.existsSync(LOG_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    let logs = JSON.parse(raw);

    if (!Array.isArray(logs)) {
      logs = [];
    }

    // Nếu cấu hình onlyAlerts: Tự động loại bỏ và làm sạch các log không khớp với ngưỡng giá
    const config = getLogConfig();
    if (config.onlyAlerts) {
      const initialCount = logs.length;
      logs = logs.filter(l => l.status === 'ALERT' || l.status === 'ORDER_PLACED' || l.status === 'SUCCESS' || l.status === 'ERROR');
      if (logs.length < initialCount) {
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
      }
    }

    // Áp dụng bộ lọc nếu có
    if (filter.status && filter.status !== 'ALL') {
      logs = logs.filter(l => l.status === filter.status);
    }
    if (filter.productName && filter.productName.trim()) {
      const q = filter.productName.toLowerCase();
      logs = logs.filter(l => (l.productName || '').toLowerCase().includes(q));
    }
    if (filter.fromTime) {
      const from = new Date(filter.fromTime).getTime();
      logs = logs.filter(l => new Date(l.timestamp).getTime() >= from);
    }
    if (filter.toTime) {
      const to = new Date(filter.toTime).getTime();
      logs = logs.filter(l => new Date(l.timestamp).getTime() <= to);
    }

    return logs;
  } catch (err) {
    console.error('[Logger] Lỗi đọc history.json:', err.message);
    return [];
  }
}

/**
 * Thêm một danh sách bản ghi log cùng lúc (Batch write)
 * Tự động xóa bớt các log cũ nếu tổng số lượng vượt quá cấu hình
 */
function addLogEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  try {
    ensureDataDir();
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      try {
        logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
      } catch (e) {
        logs = [];
      }
    }

    const config = getLogConfig();

    // Người dùng yêu cầu: Không cần lưu các log không khớp với ngưỡng giá
    // Nếu log không khớp với ngưỡng giá tồn tại thì hãy xóa log đó đi
    let validEntries = entries;
    if (config.onlyAlerts) {
      validEntries = entries.filter(e => e.status === 'ALERT' || e.status === 'ORDER_PLACED' || e.status === 'SUCCESS' || e.status === 'ERROR');
    }

    // Nếu không có log nào khớp với ngưỡng giá:
    // Kiểm tra và dọn sạch các log không khớp đang tồn tại trong file nếu có
    if (validEntries.length === 0) {
      if (config.onlyAlerts && logs.some(l => l.status !== 'ALERT' && l.status !== 'ORDER_PLACED' && l.status !== 'SUCCESS' && l.status !== 'ERROR')) {
        const cleaned = logs.filter(l => l.status === 'ALERT' || l.status === 'ORDER_PLACED' || l.status === 'SUCCESS' || l.status === 'ERROR');
        fs.writeFileSync(LOG_FILE, JSON.stringify(cleaned, null, 2), 'utf-8');
      }
      return [];
    }

    const newItems = validEntries.map(entry => ({
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      timestamp: entry.timestamp || new Date().toISOString(),
      cycleId: entry.cycleId || 1,
      productName: entry.productName || 'Không tên',
      productUrl: entry.productUrl || '',
      currentPrice: entry.currentPrice !== undefined ? entry.currentPrice : null,
      quantity: entry.quantity || 1,
      threshold: entry.threshold || 550000,
      status: entry.status || 'ALERT',
      isNewAlert: !!entry.isNewAlert,
      alertTime: entry.alertTime || (entry.status === 'ALERT' ? new Date().toISOString() : null),
      audioStatus: entry.audioStatus || 'N/A',
      telegramStatus: entry.telegramStatus || 'N/A',
      errorMessage: entry.errorMessage || ''
    }));

    // Đưa log mới lên đầu
    logs.unshift(...newItems);

    // Tự động cắt tỉa / xóa bớt log cũ
    const { trimmedLogs, removedCount } = trimLogs(logs, config);
    if (removedCount > 0) {
      console.log(`[Logger] Tự động xóa ${removedCount} log cũ / không khớp ngưỡng (Duy trì tối đa ${config.maxEntries} bản ghi).`);
    }

    fs.writeFileSync(LOG_FILE, JSON.stringify(trimmedLogs, null, 2), 'utf-8');
    return newItems;
  } catch (err) {
    console.error('[Logger] Lỗi ghi batch history.json:', err.message);
    return [];
  }
}

/**
 * Thêm một bản ghi log mới (Đơn lẻ)
 */
function addLogEntry(entry) {
  const res = addLogEntries([entry]);
  return res && res.length > 0 ? res[0] : null;
}

/**
 * Kích hoạt dọn dẹp các log cũ theo cấu hình (hoặc thông số thủ công)
 */
function pruneLogs(manualOptions = {}) {
  try {
    ensureDataDir();
    if (!fs.existsSync(LOG_FILE)) return { deletedCount: 0, remainingCount: 0 };
    let logs = [];
    try {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    } catch (e) {
      logs = [];
    }
    const config = { ...getLogConfig(), onlyAlerts: true, ...manualOptions };
    const { trimmedLogs, removedCount } = trimLogs(logs, config);
    if (removedCount > 0 || logs.length !== trimmedLogs.length) {
      fs.writeFileSync(LOG_FILE, JSON.stringify(trimmedLogs, null, 2), 'utf-8');
      console.log(`[Logger] Đã dọn dẹp ${removedCount} log không khớp hoặc cũ. Còn lại: ${trimmedLogs.length} bản ghi.`);
    }
    return { deletedCount: removedCount, remainingCount: trimmedLogs.length };
  } catch (err) {
    console.error('[Logger] Lỗi pruneLogs:', err.message);
    return { deletedCount: 0, remainingCount: 0 };
  }
}

/**
 * Cập nhật trạng thái âm thanh của log gần nhất cho một cảnh báo
 */
function updateLogAudioStatus(logId, audioStatus) {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    let found = false;
    for (const item of logs) {
      if (item.id === logId) {
        item.audioStatus = audioStatus;
        found = true;
        break;
      }
    }
    if (found) {
      fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[Logger] Lỗi cập nhật audioStatus:', err.message);
  }
}

/**
 * Cập nhật trạng thái gửi Telegram của log
 */
function updateLogTelegramStatus(logId, telegramStatus) {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
    let found = false;
    for (const item of logs) {
      if (item.id === logId) {
        item.telegramStatus = telegramStatus;
        found = true;
        break;
      }
    }
    if (found) {
      fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('[Logger] Lỗi cập nhật telegramStatus:', err.message);
  }
}

/**
 * Xóa toàn bộ nhật ký (khi người dùng xác nhận xóa sạch)
 */
function clearLogs() {
  try {
    ensureDataDir();
    fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Logger] Lỗi xóa history.json:', err.message);
    return false;
  }
}

/**
 * Xuất dữ liệu log sang CSV
 */
function exportCSV() {
  const logs = getLogs();
  const headers = [
    'Thời gian',
    'Chu kỳ quét',
    'Tên sản phẩm',
    'Giá hiện tại (VNĐ)',
    'Ngưỡng (VNĐ)',
    'Kết quả',
    'Cảnh báo mới',
    'Thời gian cảnh báo',
    'Trạng thái âm thanh',
    'Telegram',
    'URL',
    'Ghi chú lỗi'
  ];

  const escapeCSV = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = logs.map(l => [
    escapeCSV(new Date(l.timestamp).toLocaleString('vi-VN')),
    escapeCSV(l.cycleId),
    escapeCSV(l.productName),
    escapeCSV(l.status === 'SUCCESS' ? '—' : (l.currentPrice !== null ? l.currentPrice : 'UNKNOWN')),
    escapeCSV(l.threshold ? `${Number(l.threshold).toLocaleString('vi-VN')} ₫` : '—'),
    escapeCSV(l.status),
    escapeCSV(l.isNewAlert ? 'CÓ' : 'KHÔNG'),
    escapeCSV(l.alertTime ? new Date(l.alertTime).toLocaleString('vi-VN') : ''),
    escapeCSV(l.status === 'SUCCESS' ? '—' : l.audioStatus),
    escapeCSV(l.status === 'SUCCESS' ? '—' : l.telegramStatus),
    escapeCSV(l.productUrl),
    escapeCSV(l.errorMessage)
  ].join(','));

  // Thêm BOM UTF-8 để Excel hiển thị đúng tiếng Việt
  return '\uFEFF' + [headers.map(escapeCSV).join(','), ...rows].join('\r\n');
}

module.exports = {
  getLogs,
  addLogEntry,
  addLogEntries,
  trimLogs,
  pruneLogs,
  updateLogAudioStatus,
  updateLogTelegramStatus,
  clearLogs,
  exportCSV
};
