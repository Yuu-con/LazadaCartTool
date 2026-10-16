const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

const DEFAULT_CONFIG = {
  cartUrl: 'https://cart.lazada.vn/cart', // URL giỏ hàng Lazada
  priceThreshold: 550000,          // Ngưỡng cảnh báo mặc định 550.000 VNĐ
  checkIntervalSeconds: 30,       // Khoảng cách giữa các chu kỳ quét mặc định 30 giây
  autoOrder: true,                // Tự động tích chọn, bấm thanh toán và đặt hàng khi giá dưới ngưỡng
  repeatAlertOnSameLowPrice: false,// Không cảnh báo lại nếu giá vẫn thấp như cũ
  maxLogEntries: 500,             // Giới hạn bản ghi nhật ký tối đa, tự động xóa log cũ khi vượt quá
  autoCleanNormalLogs: true,      // Ưu tiên dọn dẹp các log NORMAL cũ để giữ lại lịch sử cảnh báo ALERT
  onlyAlerts: true,               // Không lưu log không khớp ngưỡng giá; chỉ lưu các sản phẩm khớp giá (ALERT)
  logRetentionDays: 3,            // Tự động xóa các log cũ hơn số ngày này
  telegram: {
    enabled: false,
    botToken: '',
    chatId: '',
    batchNotifications: true      // Gộp các sản phẩm thấp giá trong cùng 1 chu kỳ hoặc gửi riêng
  }
};

function ensureDataDir() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadConfig() {
  try {
    ensureDataDir();
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed, telegram: { ...DEFAULT_CONFIG.telegram, ...(parsed.telegram || {}) } };
    }
  } catch (err) {
    console.error('[Config] Lỗi đọc config.json, dùng cấu hình mặc định:', err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(newConfig) {
  try {
    ensureDataDir();
    const current = loadConfig();
    const merged = {
      ...current,
      ...newConfig,
      telegram: {
        ...current.telegram,
        ...(newConfig.telegram || {})
      }
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  } catch (err) {
    console.error('[Config] Lỗi lưu config.json:', err.message);
    throw err;
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  DEFAULT_CONFIG
};
