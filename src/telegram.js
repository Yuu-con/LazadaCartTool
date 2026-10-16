const https = require('https');

/**
 * Tách chuỗi Chat ID hoặc User ID thành mảng các ID riêng biệt
 * Hỗ trợ các định dạng:
 * - Chuỗi đơn: "123456789"
 * - Phân tách bởi dấu phẩy, chấm phẩy, khoảng trắng, xuống dòng: "123456, 789012; -10098765"
 * - Dạng mảng: ["123456", "789012"]
 */
function parseChatIds(chatIdInput) {
  if (!chatIdInput) return [];
  if (Array.isArray(chatIdInput)) {
    return chatIdInput.map(id => String(id).trim()).filter(Boolean);
  }
  return String(chatIdInput)
    .split(/[,;\s\n]+/)
    .map(id => id.trim())
    .filter(Boolean);
}

/**
 * Gửi tin nhắn đến 1 Chat ID cụ thể
 */
function sendSingleTelegramMessage(botToken, chatId, text, parseMode = 'HTML') {
  return new Promise((resolve) => {
    if (!botToken || !chatId) {
      return resolve({
        success: false,
        error: 'Thiếu Bot Token hoặc Chat ID'
      });
    }

    const payload = JSON.stringify({
      chat_id: String(chatId).trim(),
      text: text,
      parse_mode: parseMode,
      disable_web_page_preview: false
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${botToken.trim()}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000 // 10s timeout
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) {
            resolve({
              success: true,
              chatId: String(chatId).trim(),
              messageId: json.result?.message_id
            });
          } else {
            resolve({
              success: false,
              chatId: String(chatId).trim(),
              error: json.description || `Lỗi Telegram HTTP ${res.statusCode}`
            });
          }
        } catch (err) {
          resolve({
            success: false,
            chatId: String(chatId).trim(),
            error: `Lỗi parse phản hồi Telegram: ${err.message}`
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        chatId: String(chatId).trim(),
        error: `Lỗi kết nối mạng đến api.telegram.org: ${err.message}`
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        chatId: String(chatId).trim(),
        error: 'Hết thời gian kết nối (Timeout) đến Telegram API'
      });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Gửi một tin nhắn văn bản qua Telegram Bot API (Hỗ trợ 1 hoặc NHIỀU Chat ID)
 *
 * @param {string} botToken
 * @param {string|string[]} chatId - Một ID hoặc nhiều ID cách nhau bởi dấu phẩy, khoảng trắng
 * @param {string} text
 * @param {string} parseMode - 'Markdown' hoặc 'HTML'
 * @returns {Promise<{success: boolean, messageId?: number, total?: number, sentCount?: number, error?: string}>}
 */
async function sendTelegramMessage(botToken, chatId, text, parseMode = 'HTML') {
  const ids = parseChatIds(chatId);
  if (!botToken || ids.length === 0) {
    return {
      success: false,
      error: 'Thiếu Bot Token hoặc Chat ID'
    };
  }

  if (ids.length === 1) {
    return await sendSingleTelegramMessage(botToken, ids[0], text, parseMode);
  }

  // Gửi song song đến tất cả các Chat ID
  const results = await Promise.all(
    ids.map(id => sendSingleTelegramMessage(botToken, id, text, parseMode))
  );

  const successCount = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success);

  return {
    success: successCount > 0,
    total: ids.length,
    sentCount: successCount,
    error: failures.length > 0 ? failures.map(f => `[${f.chatId}]: ${f.error}`).join('; ') : undefined,
    results
  };
}

/**
 * Tạo nội dung thông báo chuẩn hóa theo mẫu yêu cầu
 * 🔔 LAZADA — PHÁT HIỆN GIÁ THẤP
 * - Sản phẩm: [Tên sản phẩm]
 * - Giá hiện tại: [Giá] VNĐ
 * - Ngưỡng cảnh báo: 550.000 VNĐ
 * - Thời điểm: [Ngày giờ]
 * - Trạng thái: Giá thấp hơn ngưỡng
 * - Liên kết: [URL sản phẩm nếu có]
 */
function formatProductAlertMessage(item, threshold) {
  const timeStr = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });

  const priceFormatted = item.currentPrice !== null && item.currentPrice !== undefined
    ? item.currentPrice.toLocaleString('vi-VN')
    : 'Chưa xác định';
  const thresholdFormatted = Number(threshold).toLocaleString('vi-VN');

  let msg = `🔔 <b>LAZADA — PHÁT HIỆN GIÁ THẤP</b>\n\n`;
  msg += `• <b>Sản phẩm:</b> ${escapeHTML(item.productName)}\n`;
  msg += `• <b>Giá hiện tại:</b> <b>${priceFormatted} VNĐ</b>\n`;
  msg += `• <b>Ngưỡng cảnh báo:</b> ${thresholdFormatted} VNĐ\n`;
  msg += `• <b>Thời điểm:</b> ${timeStr}\n`;
  msg += `• <b>Trạng thái:</b> ⚠️ Giá thấp hơn ngưỡng\n`;

  if (item.productUrl) {
    msg += `• <b>Liên kết:</b> <a href="${item.productUrl}">Xem chi tiết sản phẩm trên Lazada</a>\n`;
  } else {
    msg += `• <b>Liên kết:</b> Không có URL sản phẩm\n`;
  }

  return msg;
}

/**
 * Tạo nội dung thông báo gộp nhiều sản phẩm trong một chu kỳ quét
 */
function formatBatchAlertMessage(items, threshold) {
  const timeStr = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
  const thresholdFormatted = Number(threshold).toLocaleString('vi-VN');

  let msg = `🔔 <b>LAZADA — PHÁT HIỆN ${items.length} SẢN PHẨM GIÁ THẤP</b>\n`;
  msg += `⏰ <i>Thời điểm: ${timeStr}</i>\n`;
  msg += `🎯 <i>Ngưỡng cảnh báo: ${thresholdFormatted} VNĐ</i>\n\n`;

  items.forEach((item, index) => {
    const priceFormatted = item.currentPrice ? item.currentPrice.toLocaleString('vi-VN') : 'Unknown';
    msg += `<b>${index + 1}. ${escapeHTML(item.productName)}</b>\n`;
    msg += `   💵 Giá: <b>${priceFormatted} VNĐ</b>\n`;
    if (item.productUrl) {
      msg += `   🔗 <a href="${item.productUrl}">Mở sản phẩm</a>\n`;
    }
    msg += `\n`;
  });

  return msg;
}

/**
 * Tạo nội dung thông báo khi tự động đặt hàng thành công
 */
function formatOrderSuccessMessage(item, threshold) {
  const timeStr = new Date().toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });
  const priceFormatted = item.currentPrice ? item.currentPrice.toLocaleString('vi-VN') : 'Unknown';
  const thresholdFormatted = Number(threshold).toLocaleString('vi-VN');

  let msg = `🎉 <b>LAZADA — TỰ ĐỘNG ĐẶT HÀNG THÀNH CÔNG!</b>\n\n`;
  msg += `• <b>Sản phẩm:</b> ${escapeHTML(item.productName)}\n`;
  msg += `• <b>Giá mua:</b> <b>${priceFormatted} VNĐ</b>\n`;
  msg += `• <b>Ngưỡng cài đặt:</b> ${thresholdFormatted} VNĐ\n`;
  msg += `• <b>Thời điểm:</b> ${timeStr}\n`;
  msg += `• <b>Trạng thái:</b> 🚀 Đã tích chọn ô sản phẩm, bấm Thanh toán và bấm Đặt hàng thành công!\n`;
  if (item.productUrl) {
    msg += `• <b>Liên kết:</b> <a href="${item.productUrl}">Xem chi tiết sản phẩm</a>\n`;
  }
  return msg;
}

function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  sendTelegramMessage,
  parseChatIds,
  formatProductAlertMessage,
  formatBatchAlertMessage,
  formatOrderSuccessMessage
};
